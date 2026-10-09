using System.Text.Json;
using System.Threading.Channels;
using Replay.Format;

namespace BigReplay.Live;

/// <summary>Line kinds in the live stream. The payload shapes match the replay file exactly.</summary>
public enum LiveRecordKind : byte
{
    Hello = 1,
    Header = 2,
    Frame = 3,
    Event = 4,
    Bye = 5,
}

internal sealed record LiveRecord(LiveRecordKind Kind, string Json);

/// <summary>
/// Broadcast buffer for the recorder's live stream: one JSON line per record, newline
/// terminated, in publish order. A client that connects mid-run receives the whole session
/// (hello, header, every frame and event so far) and then continues live on the same socket,
/// which is what lets a viewer open at the live point with the whole run behind it to rewind.
///
/// One session is one recording run. When the recorder finishes a run and starts the next,
/// <see cref="BeginRun"/> begins a new session and existing clients get a fresh hello — no
/// reconnect required.
/// </summary>
public sealed class LiveSession
{
    public const int ProtocolVersion = 1;

    /// <summary>
    /// Per-client queue depth. A client that cannot keep up is dropped rather than stalling the
    /// capture loop or growing without bound; it reconnects and receives a fresh backlog.
    /// </summary>
    public const int SubscriberQueueCapacity = 4096;

    /// <summary>Every record is one newline-terminated JSON line, as docs/format.md describes.</summary>
    private static string Line(object payload) => JsonSerializer.Serialize(payload, ReplayJson.Options) + "\n";

    private readonly object _gate = new();
    private readonly List<LiveRecord> _records = [];
    private readonly List<LiveSubscription> _subscriptions = [];
    private readonly string _appName;
    private string _sessionId = "";
    private DateTime _startedAt;
    private double _sampleIntervalSec;
    private string _gameVersion = "";
    private string _unityVersion = "";
    private bool _running;
    private long _frames;
    private long _events;

    public LiveSession(string appName = "Big Replay") => _appName = appName;

    public string SessionId { get { lock (_gate) return _sessionId; } }
    public bool IsRunning { get { lock (_gate) return _running; } }
    public long FrameCount { get { lock (_gate) return _frames; } }
    public long EventCount { get { lock (_gate) return _events; } }
    public int SubscriberCount { get { lock (_gate) return _subscriptions.Count; } }

    /// <summary>
    /// The hello line. <paramref name="backlogFrames"/> is how much of the run the receiver is
    /// about to be sent, so a viewer can wait for the whole start of the run and then open at the
    /// live point instead of guessing from whatever arrives first.
    /// </summary>
    private string HelloLine(long backlogFrames) => Line(new
    {
        hello = new
        {
            protocol = ProtocolVersion,
            session = _sessionId,
            app = _appName,
            startedAt = _startedAt,
            sampleIntervalSec = _sampleIntervalSec,
            gameVersion = _gameVersion,
            unityVersion = _unityVersion,
            backlogFrames,
        },
    });

    /// <summary>Starts a new session: the stream restarts at a hello and the frame counter resets.</summary>
    public void BeginRun(ReplayHeader header)
    {
        ArgumentNullException.ThrowIfNull(header);
        string headerJson = Line(new { header });

        lock (_gate)
        {
            _sessionId = Guid.NewGuid().ToString("N");
            _startedAt = DateTime.UtcNow;
            _sampleIntervalSec = header.SampleIntervalSec;
            _gameVersion = header.GameVersion;
            _unityVersion = header.UnityVersion;
            _running = true;
            _frames = 0;
            _events = 0;
            _records.Clear();
            AppendLocked(new LiveRecord(LiveRecordKind.Hello, HelloLine(0)));
            AppendLocked(new LiveRecord(LiveRecordKind.Header, headerJson));
        }
    }

    /// <summary>Serializes first, then publishes: a bad read can never strand a half-written line.</summary>
    public void PublishFrame(ReplayFrame frame)
    {
        ArgumentNullException.ThrowIfNull(frame);
        string json = Line(new { frame });
        lock (_gate)
        {
            if (!_running)
            {
                return;
            }
            _frames++;
            AppendLocked(new LiveRecord(LiveRecordKind.Frame, json));
        }
    }

    public void PublishEvent(ReplayEvent replayEvent)
    {
        ArgumentNullException.ThrowIfNull(replayEvent);
        string json = Line(new { events = new[] { replayEvent } });
        lock (_gate)
        {
            if (!_running)
            {
                return;
            }
            _events++;
            AppendLocked(new LiveRecord(LiveRecordKind.Event, json));
        }
    }

    /// <summary>Marks the run finished. The socket stays open: the next run sends a new hello.</summary>
    public void EndRun(string reason)
    {
        string json = Line(new { bye = new { reason } });
        lock (_gate)
        {
            if (!_running)
            {
                return;
            }
            _running = false;
            AppendLocked(new LiveRecord(LiveRecordKind.Bye, json));
        }
    }

    /// <summary>
    /// Registers a subscriber and captures the backlog in the same critical section, so no record
    /// can slip between the snapshot and the live feed. <paramref name="send"/> returns false when
    /// the transport is gone.
    /// </summary>
    public LiveSubscription Subscribe(Func<string, bool> send)
    {
        ArgumentNullException.ThrowIfNull(send);
        var subscription = new LiveSubscription(this, send);
        lock (_gate)
        {
            // The hello this client receives is regenerated with the backlog it is about to get;
            // the recorded hello stays as it was published for the session's own history.
            LiveRecord[] backlog = _records.ToArray();
            if (backlog.Length > 0 && backlog[0].Kind == LiveRecordKind.Hello)
            {
                backlog[0] = backlog[0] with { Json = HelloLine(_frames) };
            }
            subscription.Backlog = backlog;
            _subscriptions.Add(subscription);
        }
        subscription.Start();
        return subscription;
    }

    internal void Unsubscribe(LiveSubscription subscription)
    {
        lock (_gate)
        {
            _subscriptions.Remove(subscription);
        }
    }

    private void AppendLocked(LiveRecord record)
    {
        _records.Add(record);
        for (int i = _subscriptions.Count - 1; i >= 0; i--)
        {
            _subscriptions[i].Enqueue(record.Json);
        }
    }
}

/// <summary>
/// One client's view of a <see cref="LiveSession"/>. The backlog is written first, then queued
/// live records follow it — nothing from before the subscription can arrive after the snapshot.
/// </summary>
public sealed class LiveSubscription : IDisposable
{
    private readonly LiveSession _session;
    private readonly Func<string, bool> _send;
    private readonly Channel<string> _queue = Channel.CreateBounded<string>(
        new BoundedChannelOptions(LiveSession.SubscriberQueueCapacity)
        {
            FullMode = BoundedChannelFullMode.DropWrite,
            SingleReader = true,
            SingleWriter = false,
        });
    private readonly CancellationTokenSource _stop = new();
    private Task _pump = Task.CompletedTask;
    private LiveRecord[] _backlog = [];
    private int _overflowed;

    internal LiveSubscription(LiveSession session, Func<string, bool> send)
    {
        _session = session;
        _send = send;
    }

    internal LiveRecord[] Backlog { get => _backlog; set => _backlog = value; }

    /// <summary>True when this client fell behind and was cut loose to reconnect.</summary>
    public bool Overflowed => Volatile.Read(ref _overflowed) != 0;

    /// <summary>Completes when the client stops receiving (overflow, transport failure or dispose).</summary>
    public Task Completion => _pump;

    internal void Start() => _pump = Task.Run(PumpAsync);

    internal void Enqueue(string line)
    {
        if (_queue.Writer.TryWrite(line))
        {
            return;
        }
        // Bounded queue full: this client is not keeping up with a run it can always re-fetch.
        Interlocked.Increment(ref _overflowed);
        _stop.Cancel();
    }

    private async Task PumpAsync()
    {
        try
        {
            foreach (LiveRecord record in _backlog)
            {
                if (_stop.IsCancellationRequested || !_send(record.Json))
                {
                    return;
                }
            }
            _backlog = [];
            while (await _queue.Reader.WaitToReadAsync(_stop.Token).ConfigureAwait(false))
            {
                while (_queue.Reader.TryRead(out string? line))
                {
                    if (line is null)
                    {
                        continue;
                    }
                    if (!_send(line))
                    {
                        return;
                    }
                }
            }
        }
        catch (OperationCanceledException)
        {
            // client disconnected, overflowed, or the server is stopping
        }
        catch (Exception)
        {
            // A broken socket is this client's problem; the recorder keeps capturing.
        }
        finally
        {
            _session.Unsubscribe(this);
        }
    }

    public void Dispose()
    {
        _stop.Cancel();
        _queue.Writer.TryComplete();
        _session.Unsubscribe(this);
    }
}