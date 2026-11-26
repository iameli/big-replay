using System.Diagnostics;
using System.Threading.Channels;
using Replay.Format;

namespace BigReplay.Desktop;

internal enum LiveSplitMode
{
    Off,
    LogOnly,
    Split,
}

/// <summary>
/// Opt-in LiveSplit link. Big Replay detects tower completion; LiveSplit owns the clock.
/// The only timer-changing command this class ever sends is `split`, and only while the
/// current segment name accepts the completed tower and LiveSplit reports Running.
/// </summary>
internal sealed class LiveSplitAutosplit : IAsyncDisposable
{
    private readonly TowerProgressTracker _towers;
    private readonly Channel<ObservedCompletion> _completions = Channel.CreateUnbounded<ObservedCompletion>(
        new UnboundedChannelOptions { SingleReader = true, SingleWriter = false });
    private readonly Channel<EndgameTeleport> _endgames = Channel.CreateUnbounded<EndgameTeleport>(
        new UnboundedChannelOptions { SingleReader = true, SingleWriter = false });
    private readonly CancellationTokenSource _stop = new();
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly object _statusGate = new();
    private readonly List<ObservedCompletion> _pending = [];
    private readonly HashSet<string> _latched = new(StringComparer.Ordinal);
    private readonly string _logPath;
    private LiveSplitPipe? _pipe;
    private LiveSplitRoute? _route;
    private Task? _loop;
    private int _mode;
    private volatile int _enabledMask;
    private bool _armed;
    private bool _sessionBaselined;
    private long _trackerSession = -1;
    private long _armedAt;
    private long _lastPoll;
    private int _attempt = -1;
    private int _splitIndex;
    private string _phase = "NotRunning";
    private string _segment = "-";
    private string? _gameName;
    private bool _gameNameProbed;
    private bool _gameNameUnsupported;
    private string _status = "LiveSplit autosplit is off.";
    private string _lastAction = "No splits yet.";
    private string? _splitTimeWarning;
    private string? _configAutoSplitterWarning;
    private string? _unexpectedSplitWarning;
    private int _unexpectedSplitWarningAttempt = -1;
    private long _lastConfigCheck;
    private EndgameTeleport? _pendingEndgame;
    private bool _endgameSplitSent;
    private bool _endgameWaitLogged;
    private volatile bool _finishOnEndgameTeleport = true;

    public LiveSplitAutosplit(TowerProgressTracker towers)
    {
        _towers = towers;
        _enabledMask = (1 << GourdReceptacles.Groups.Count) - 1;
        _logPath = DefaultLogPath();
    }

    private static string DefaultLogPath()
    {
        string documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        string directory = string.IsNullOrWhiteSpace(documents)
            ? Path.GetTempPath()
            : Path.Combine(documents, "BigReplay");
        return Path.Combine(directory, "livesplit.log");
    }

    public LiveSplitMode Mode
    {
        get => (LiveSplitMode)Volatile.Read(ref _mode);
        set
        {
            var previous = (LiveSplitMode)Interlocked.Exchange(ref _mode, (int)value);
            if (previous == value)
            {
                return;
            }
            if (value == LiveSplitMode.Off)
            {
                lock (_statusGate)
                {
                    _pending.Clear();
                    _armed = false;
                    _pendingEndgame = null;
                }
                SetStatus("LiveSplit autosplit is off.");
            }
            else
            {
                Log($"mode: {(value == LiveSplitMode.LogOnly ? "log only" : "send splits")}");
            }
        }
    }

    public string Status
    {
        get { lock (_statusGate) return _status; }
    }

    /// <summary>Send the final split when the endgame-room teleport is detected.</summary>
    public bool FinishOnEndgameTeleport
    {
        get => _finishOnEndgameTeleport;
        set
        {
            _finishOnEndgameTeleport = value;
            if (!value)
            {
                _pendingEndgame = null;
            }
        }
    }

    public void SetTowerEnabled(string tower, bool enabled)
    {
        int index = -1;
        for (int i = 0; i < GourdReceptacles.Groups.Count; i++)
        {
            if (GourdReceptacles.Groups[i].Name == tower)
            {
                index = i;
                break;
            }
        }
        if (index < 0)
        {
            return;
        }
        int mask = _enabledMask;
        _enabledMask = enabled ? mask | (1 << index) : mask & ~(1 << index);
    }

    private bool IsTowerEnabled(int index) => (_enabledMask & (1 << index)) != 0;

    public void Start()
    {
        _loop ??= Task.Run(() => RunAsync(_stop.Token));
    }

    /// <summary>Non-blocking callback from the recording loop. Never touches the pipe.</summary>
    public void Observe(TowerCompletion completion)
    {
        if (Mode == LiveSplitMode.Off)
        {
            return;
        }
        _completions.Writer.TryWrite(new ObservedCompletion(completion, _clock.ElapsedMilliseconds));
    }

    /// <summary>Non-blocking callback from the recording loop when the endgame room is reached.</summary>
    public void ObserveEndgame(EndgameTeleport teleport)
    {
        if (Mode == LiveSplitMode.Off || !_finishOnEndgameTeleport)
        {
            return;
        }
        _endgames.Writer.TryWrite(teleport);
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                if (Mode == LiveSplitMode.Off)
                {
                    DisposePipe();
                    SetStatus("LiveSplit autosplit is off.");
                    await Task.Delay(250, cancellationToken).ConfigureAwait(false);
                    continue;
                }
                if (_pipe is null)
                {
                    await ConnectAsync(cancellationToken).ConfigureAwait(false);
                }
                await TickAsync(cancellationToken).ConfigureAwait(false);
                await Task.Delay(100, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                DisposePipe();
                SetStatus($"LiveSplit: waiting for LiveSplit ({ex.Message})");
                await Task.Delay(1000, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private async Task ConnectAsync(CancellationToken cancellationToken)
    {
        var pipe = new LiveSplitPipe();
        await pipe.ConnectAsync(cancellationToken).ConfigureAwait(false);
        _pipe = pipe;

        if (!_gameNameProbed)
        {
            _gameNameProbed = true;
            if (!_gameNameUnsupported)
            {
                try
                {
                    string name = await pipe.QueryAsync("getgamename", cancellationToken).ConfigureAwait(false);
                    _gameName = string.IsNullOrWhiteSpace(name) ? null : name.Trim();
                }
                catch (TimeoutException)
                {
                    // LiveSplit 1.8.37 has no getgamename. Drop this stream and reconnect once
                    // without the probe; the route/current-segment checks remain the guard.
                    _gameNameUnsupported = true;
                    pipe.Dispose();
                    _pipe = null;
                    throw;
                }
            }
        }

        _route = LiveSplitRoute.TryLoad();
        _configAutoSplitterWarning = _route?.AutoSplitter;
        if (_configAutoSplitterWarning is not null)
        {
            Log($"warning: LiveSplit has an autosplitter configured: {_configAutoSplitterWarning}");
        }
        _lastPoll = 0;
        if (_route is not null)
        {
            Log($"connected; route {_route.Segments.Count} segments from {Path.GetFileName(_route.SourcePath)}");
        }
        else
        {
            Log("connected; route file unavailable, using live segment names");
        }
    }

    private async Task TickAsync(CancellationToken cancellationToken)
    {
        long now = _clock.ElapsedMilliseconds;
        LiveSplitSnapshot? snapshot = null;
        if (now - _lastPoll >= 250)
        {
            snapshot = await ReadStateAsync(cancellationToken).ConfigureAwait(false);
            _lastPoll = now;
            ApplySnapshot(snapshot.Value);
        }

        bool added = await ProcessCompletionsAsync(cancellationToken).ConfigureAwait(false);
        if (snapshot is not null || added)
        {
            await TrySplitsAsync(cancellationToken).ConfigureAwait(false);
        }

        await ProcessEndgamesAsync(cancellationToken).ConfigureAwait(false);

        // A new recording session starts with an empty tracker. Baseline whatever is already
        // full on its first observed frame so attach/late-join never earns a split.
        long session = _towers.Session;
        if (session != _trackerSession)
        {
            _trackerSession = session;
            _sessionBaselined = false;
        }
        if (_armed && !_sessionBaselined && _towers.HasData)
        {
            Baseline();
            _sessionBaselined = true;
        }

        if (now - _lastConfigCheck >= 5000)
        {
            _lastConfigCheck = now;
            RefreshAutoSplitterWarning();
        }

        UpdateStatus();
    }

    private async Task<LiveSplitSnapshot> ReadStateAsync(CancellationToken cancellationToken)
    {
        LiveSplitPipe pipe = _pipe ?? throw new IOException("LiveSplit pipe is not connected.");
        string phase = (await pipe.QueryAsync("getcurrenttimerphase", cancellationToken).ConfigureAwait(false)).Trim();
        string attemptText = (await pipe.QueryAsync("getattemptcount", cancellationToken).ConfigureAwait(false)).Trim();
        string indexText = (await pipe.QueryAsync("getsplitindex", cancellationToken).ConfigureAwait(false)).Trim();
        string segment = (await pipe.QueryAsync("getcurrentsplitname", cancellationToken).ConfigureAwait(false)).Trim();
        if (!int.TryParse(attemptText, out int attempt) || !int.TryParse(indexText, out int index))
        {
            throw new IOException("LiveSplit returned a non-numeric attempt or split index.");
        }
        return new LiveSplitSnapshot(phase, attempt, index, segment);
    }

    private void ApplySnapshot(LiveSplitSnapshot snapshot)
    {
        int previousIndex = _splitIndex;
        _phase = snapshot.Phase;
        _segment = snapshot.Segment;
        _splitIndex = snapshot.SplitIndex;
        if (previousIndex >= 0 && snapshot.SplitIndex > previousIndex + 1 &&
            snapshot.Phase is "Running" or "Paused")
        {
            _unexpectedSplitWarning =
                $"LiveSplit advanced {snapshot.SplitIndex - previousIndex} segments without Big Replay";
            _unexpectedSplitWarningAttempt = snapshot.Attempt;
            Log($"warning: {_unexpectedSplitWarning}; another autosplitter or hotkey is active");
        }
        bool running = snapshot.Phase == "Running";
        bool gameMatches = _gameName is null ||
            _gameName.Contains("Big Walk", StringComparison.OrdinalIgnoreCase);
        if (!running || !gameMatches)
        {
            if (_armed)
            {
                FlushPending($"timer {snapshot.Phase}");
                _armed = false;
            }
            if (snapshot.Phase == "NotRunning")
            {
                _attempt = snapshot.Attempt;
            }
            _pendingEndgame = null;
            return;
        }

        bool newAttempt = snapshot.Attempt != _attempt;
        if (newAttempt)
        {
            _attempt = snapshot.Attempt;
            _latched.Clear();
            _pending.Clear();
            _endgameSplitSent = false;
            _pendingEndgame = null;
            _endgameWaitLogged = false;
            _sessionBaselined = false;
            _splitTimeWarning = null;
            if (_unexpectedSplitWarningAttempt != snapshot.Attempt)
            {
                _unexpectedSplitWarning = null;
                _unexpectedSplitWarningAttempt = -1;
            }
            _armedAt = _clock.ElapsedMilliseconds;
            _armed = true;
            Baseline();
            Log($"armed attempt {snapshot.Attempt}; {_latched.Count} full tower(s) baselined");
        }
        else if (!_armed)
        {
            _armedAt = _clock.ElapsedMilliseconds;
            _armed = true;
            Baseline();
            Log($"re-armed attempt {snapshot.Attempt}; {_latched.Count} full tower(s) baselined");
        }
    }

    private void Baseline()
    {
        foreach (string tower in _towers.CompletedTowers())
        {
            _latched.Add(tower);
        }
    }

    private async Task<bool> ProcessCompletionsAsync(CancellationToken cancellationToken)
    {
        bool added = false;
        while (_completions.Reader.TryRead(out ObservedCompletion observed))
        {
            TowerCompletion completion = observed.Completion;
            if (Mode == LiveSplitMode.Off)
            {
                continue;
            }
            if (!IsTowerEnabled(completion.GroupIndex))
            {
                Log($"{completion.Tower} full; ignored (disabled)");
                continue;
            }
            if (!_armed)
            {
                Log($"{completion.Tower} full; missed (timer {_phase}) — split manually if needed");
                continue;
            }
            if (_latched.Contains(completion.Tower))
            {
                Log($"{completion.Tower} full; already handled this attempt");
                continue;
            }
            if (observed.Stamp < _armedAt)
            {
                Log($"{completion.Tower} full before this attempt started; ignored");
                continue;
            }
            _pending.Add(observed);
            added = true;
            Log($"{completion.Tower} full at {FormatTime(completion.Time)} ({completion.Filled}/{completion.Total})");
        }
        return added;
    }

    private async Task TrySplitsAsync(CancellationToken cancellationToken)
    {
        if (_pending.Count == 0 || _pipe is null || Mode == LiveSplitMode.Off)
        {
            return;
        }
        if (Mode == LiveSplitMode.LogOnly)
        {
            await LogOnlyAsync(cancellationToken).ConfigureAwait(false);
            return;
        }

        for (int guard = 0; guard < 16 && _pending.Count > 0; guard++)
        {
            LiveSplitSnapshot snapshot = await ReadStateAsync(cancellationToken).ConfigureAwait(false);
            ApplySnapshot(snapshot);
            if (!_armed || snapshot.Phase != "Running")
            {
                FlushPending($"timer {snapshot.Phase}");
                return;
            }
            if (snapshot.Attempt != _attempt)
            {
                _pending.Clear();
                return;
            }

            string segment = CurrentSegment(snapshot);
            ObservedCompletion match = default;
            bool found = false;
            foreach (ObservedCompletion candidate in _pending)
            {
                if (TowerSegmentRoute.Accepts(segment, candidate.Completion.Tower))
                {
                    match = candidate;
                    found = true;
                    break;
                }
            }

            if (!found)
            {
                if (_route is not null && _route.Matches(snapshot.SplitIndex, snapshot.Segment))
                {
                    bool missedAny = false;
                    for (int i = _pending.Count - 1; i >= 0; i--)
                    {
                        ObservedCompletion candidate = _pending[i];
                        if (_route.FindAccepting(snapshot.SplitIndex, candidate.Completion.Tower) < 0)
                        {
                            _latched.Add(candidate.Completion.Tower);
                            Log($"missed {candidate.Completion.Tower}: no segment at or after " +
                                $"{snapshot.SplitIndex} \"{segment}\" accepts it — split manually");
                            _pending.RemoveAt(i);
                            missedAny = true;
                        }
                    }
                    if (missedAny)
                    {
                        continue;
                    }
                }
                // Current segment is manual or belongs to another tower: leave the completion
                // pending so a same-frame completion can consume the next segment.
                break;
            }

            try
            {
                await _pipe.SendAsync("split", cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _latched.Add(match.Completion.Tower);
                _pending.Remove(match);
                Log($"could not write split for {match.Completion.Tower} ({ex.Message}); " +
                    "outcome unknown — not resending");
                throw;
            }

            LiveSplitSnapshot after;
            try
            {
                after = await ReadStateAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _latched.Add(match.Completion.Tower);
                _pending.Remove(match);
                Log($"split {match.Completion.Tower} sent but not confirmed ({ex.Message}); " +
                    "outcome unknown — not resending");
                throw;
            }

            bool confirmed = after.SplitIndex > snapshot.SplitIndex || after.Phase == "Ended";
            _latched.Add(match.Completion.Tower);
            _pending.Remove(match);
            if (confirmed)
            {
                Log($"split {match.Completion.Tower}: segment {snapshot.SplitIndex} \"{segment}\" " +
                    $"→ {after.SplitIndex}");
                await CheckSplitTimestampAsync(cancellationToken).ConfigureAwait(false);
            }
            else
            {
                Log($"split {match.Completion.Tower} not confirmed (index {snapshot.SplitIndex} " +
                    $"→ {after.SplitIndex}); not resending");
            }
            ApplySnapshot(after);
            if (!confirmed)
            {
                break;
            }
        }
    }

    private async Task CheckSplitTimestampAsync(CancellationToken cancellationToken)
    {
        string lastSplit;
        try
        {
            lastSplit = (await _pipe!.QueryAsync("getlastsplittime", cancellationToken)
                .ConfigureAwait(false)).Trim();
        }
        catch (Exception ex)
        {
            lastSplit = "-";
            Log($"could not read the split timestamp: {ex.Message}");
        }
        if (lastSplit == "-")
        {
            _splitTimeWarning = "last split has no timestamp";
            Log("split advanced but stored no timestamp: LiveSplit Game Time has no " +
                "source. Switch LiveSplit to Real Time or enable a game-time/load-removal source.");
        }
        else
        {
            _splitTimeWarning = null;
        }
    }

    private async Task ProcessEndgamesAsync(CancellationToken cancellationToken)
    {
        while (_endgames.Reader.TryRead(out EndgameTeleport teleport))
        {
            if (Mode == LiveSplitMode.Off || !_finishOnEndgameTeleport)
            {
                continue;
            }
            _pendingEndgame = teleport;
            _endgameWaitLogged = false;
            Log($"endgame teleport at {FormatTime(teleport.Time)} " +
                $"({teleport.Inside}/{teleport.Located} players in room)");
        }
        if (_pendingEndgame is null || _endgameSplitSent || _pipe is null ||
            Mode == LiveSplitMode.Off || !_finishOnEndgameTeleport)
        {
            return;
        }

        LiveSplitSnapshot snapshot = await ReadStateAsync(cancellationToken).ConfigureAwait(false);
        ApplySnapshot(snapshot);
        if (_pendingEndgame is null || !_armed || snapshot.Phase != "Running")
        {
            Log($"endgame teleport; timer {snapshot.Phase}; not finishing — split manually if needed");
            _pendingEndgame = null;
            return;
        }
        if (snapshot.Attempt != _attempt)
        {
            _pendingEndgame = null;
            return;
        }

        string segment = CurrentSegment(snapshot);
        if (!IsFinishSegment(snapshot, segment))
        {
            if (!_endgameWaitLogged)
            {
                Log($"endgame teleport while segment {snapshot.SplitIndex} \"{segment}\"; " +
                    "waiting for the final segment");
                _endgameWaitLogged = true;
            }
            return;
        }

        if (Mode == LiveSplitMode.LogOnly)
        {
            Log($"would finish at segment {snapshot.SplitIndex} \"{segment}\" (endgame teleport)");
            _endgameSplitSent = true;
            _pendingEndgame = null;
            return;
        }

        bool confirmed;
        try
        {
            confirmed = await SendFinishSplitAsync(snapshot, segment, cancellationToken)
                .ConfigureAwait(false);
        }
        catch
        {
            _endgameSplitSent = true;
            _pendingEndgame = null;
            throw;
        }
        _endgameSplitSent = true;
        _pendingEndgame = null;
        if (!confirmed)
        {
            Log("finish split not confirmed; not resending");
        }
    }

    private bool IsFinishSegment(LiveSplitSnapshot snapshot, string segment)
    {
        if (_route is not null && snapshot.SplitIndex >= 0 &&
            snapshot.SplitIndex < _route.Segments.Count)
        {
            if (snapshot.SplitIndex != _route.Segments.Count - 1)
            {
                return false;
            }
            return TowerSegmentRoute.Describe(segment) == "manual" ||
                TowerSegmentRoute.IsFinishName(segment);
        }
        return TowerSegmentRoute.IsFinishName(segment);
    }

    private async Task<bool> SendFinishSplitAsync(LiveSplitSnapshot before, string segment,
        CancellationToken cancellationToken)
    {
        try
        {
            await _pipe!.SendAsync("split", cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Log($"could not write finish split ({ex.Message}); outcome unknown — not resending");
            throw;
        }

        LiveSplitSnapshot after;
        try
        {
            after = await ReadStateAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Log($"finish split sent but not confirmed ({ex.Message}); outcome unknown — not resending");
            throw;
        }

        bool confirmed = after.SplitIndex > before.SplitIndex || after.Phase == "Ended";
        if (confirmed)
        {
            Log($"finish: segment {before.SplitIndex} \"{segment}\" → {after.SplitIndex} " +
                "(endgame teleport)");
            await CheckSplitTimestampAsync(cancellationToken).ConfigureAwait(false);
        }
        else
        {
            Log($"finish split not confirmed (index {before.SplitIndex} → {after.SplitIndex}); " +
                "not resending");
        }
        ApplySnapshot(after);
        return confirmed;
    }

    private async Task LogOnlyAsync(CancellationToken cancellationToken)
    {
        LiveSplitSnapshot snapshot = await ReadStateAsync(cancellationToken).ConfigureAwait(false);
        ApplySnapshot(snapshot);
        if (!_armed)
        {
            foreach (ObservedCompletion observed in _pending)
            {
                Log($"would not split {observed.Completion.Tower}: timer {snapshot.Phase}");
            }
            _pending.Clear();
            return;
        }

        bool routeMatches = _route is not null && _route.Matches(snapshot.SplitIndex, snapshot.Segment);
        int simulatedIndex = snapshot.SplitIndex;
        for (int i = 0; i < _pending.Count;)
        {
            ObservedCompletion observed = _pending[i];
            string tower = observed.Completion.Tower;
            string segment = simulatedIndex == snapshot.SplitIndex
                ? CurrentSegment(snapshot)
                : RouteSegment(simulatedIndex);
            if (TowerSegmentRoute.Accepts(segment, tower))
            {
                Log($"would split {tower}: segment {simulatedIndex} \"{segment}\"");
                _latched.Add(tower);
                _pending.RemoveAt(i);
                simulatedIndex++;
            }
            else if (routeMatches && _route is not null)
            {
                int index = _route.FindAccepting(simulatedIndex, tower);
                if (index >= 0)
                {
                    Log($"would split {tower}: segment {index} \"{_route.Segments[index]}\"");
                    _latched.Add(tower);
                    _pending.RemoveAt(i);
                    simulatedIndex = index + 1;
                }
                else
                {
                    Log($"would not split {tower}: no segment at or after {simulatedIndex} accepts it");
                    _latched.Add(tower);
                    _pending.RemoveAt(i);
                }
            }
            else
            {
                Log($"would not split {tower}: current segment {simulatedIndex} \"{segment}\" does not accept it");
                _latched.Add(tower);
                _pending.RemoveAt(i);
            }
        }
    }

    private string CurrentSegment(LiveSplitSnapshot snapshot)
    {
        if (snapshot.Segment is not ("-" or ""))
        {
            return snapshot.Segment;
        }
        return RouteSegment(snapshot.SplitIndex);
    }

    private string RouteSegment(int index)
    {
        if (_route is not null && index >= 0 && index < _route.Segments.Count)
        {
            return _route.Segments[index];
        }
        return "-";
    }

    private void FlushPending(string reason)
    {
        foreach (ObservedCompletion observed in _pending)
        {
            _latched.Add(observed.Completion.Tower);
            Log($"missed {observed.Completion.Tower} ({reason}); split manually if needed");
        }
        _pending.Clear();
    }
    /// <summary>Re-read LiveSplit's split/layout files for a configured autosplitter. LiveSplit
    /// 1.8.37 has no pipe command that reports one, so the files are the only early warning.</summary>
    private void RefreshAutoSplitterWarning()
    {
        string? detected = LiveSplitRoute.FindAutoSplitter();
        if (string.Equals(detected, _configAutoSplitterWarning, StringComparison.Ordinal))
        {
            return;
        }
        _configAutoSplitterWarning = detected;
        if (detected is not null)
        {
            Log($"warning: LiveSplit has an autosplitter configured: {detected}");
        }
        else
        {
            Log("LiveSplit autosplitter warning cleared");
        }
    }


    private void UpdateStatus()
    {
        if (Mode == LiveSplitMode.Off)
        {
            SetStatus("LiveSplit autosplit is off.");
            return;
        }
        if (_pipe is null)
        {
            SetStatus("LiveSplit: waiting for LiveSplit…");
            return;
        }
        var parts = new List<string> { $"LiveSplit: {_phase.ToLowerInvariant()}" };
        if (_segment is not ("-" or ""))
        {
            parts.Add($"segment {_splitIndex} \"{_segment}\"");
        }
        if (!_towers.HasData)
        {
            parts.Add("waiting for gourd data");
        }
        else if (_armed)
        {
            parts.Add($"armed · attempt {_attempt} · {_latched.Count} tower(s) handled");
        }
        else
        {
            parts.Add("not armed");
        }
        parts.Add(_finishOnEndgameTeleport ? "finish: auto on teleport" : "finish: manual");
        if (_gameName is not null && !_gameName.Contains("Big Walk", StringComparison.OrdinalIgnoreCase))
        {
            parts.Add($"game \"{_gameName}\"");
        }
        string status = string.Join(" · ", parts) + $"\nLast: {_lastAction}";
        if (_configAutoSplitterWarning is not null)
        {
            status = $"Warning: {_configAutoSplitterWarning}. Remove/disable it — two producers " +
                $"will double-split.\n{status}";
        }
        if (_unexpectedSplitWarning is not null)
        {
            status = $"Warning: {_unexpectedSplitWarning}. Check for an old autosplitter or " +
                $"hotkey.\n{status}";
        }
        if (_splitTimeWarning is not null)
        {
            status += $"\nWarning: {_splitTimeWarning}. Switch LiveSplit to Real Time or " +
                "enable a game-time/load-removal source.";
        }
        SetStatus(status);
    }

    private void SetStatus(string status)
    {
        lock (_statusGate)
        {
            _status = status;
        }
    }

    private void Log(string message)
    {
        lock (_statusGate)
        {
            _lastAction = message;
        }
        try
        {
            string? directory = Path.GetDirectoryName(_logPath);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }
            File.AppendAllText(_logPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {message}{Environment.NewLine}");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Status still shows the action; a log failure must never affect recording.
        }
    }

    private void DisposePipe()
    {
        var pipe = Interlocked.Exchange(ref _pipe, null);
        pipe?.Dispose();
        _armed = false;
        _pendingEndgame = null;
    }

    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        _completions.Writer.TryComplete();
        _endgames.Writer.TryComplete();
        if (_loop is not null)
        {
            try
            {
                await _loop.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }
        DisposePipe();
        _stop.Dispose();
    }

    private static string FormatTime(double seconds) => TimeSpan.FromSeconds(seconds).ToString(@"hh\:mm\:ss\.ff");

    private readonly record struct ObservedCompletion(TowerCompletion Completion, long Stamp);

    private readonly record struct LiveSplitSnapshot(string Phase, int Attempt, int SplitIndex, string Segment);
}
