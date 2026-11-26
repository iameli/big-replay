using System.IO.Pipes;
using System.Text;

namespace BigReplay.Desktop;

/// <summary>
/// One LiveSplit named-pipe connection. The protocol is UTF-8, newline-delimited commands
/// with one line of response per querying command; mutating commands (including `split`)
/// have no acknowledgement. A timed-out query poisons the stream, so the connection is
/// dropped and the caller reconnects rather than reading another command's response.
/// </summary>
internal sealed class LiveSplitPipe : IDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private NamedPipeClientStream? _pipe;
    private StreamReader? _reader;
    private StreamWriter? _writer;
    private int _disposed;

    public bool IsConnected => _pipe?.IsConnected == true;

    public async Task ConnectAsync(CancellationToken cancellationToken)
    {
        DisposeConnection();
        var pipe = new NamedPipeClientStream(".", "LiveSplit", PipeDirection.InOut, PipeOptions.Asynchronous);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromMilliseconds(750));
        try
        {
            await pipe.ConnectAsync(timeout.Token).ConfigureAwait(false);
        }
        catch
        {
            pipe.Dispose();
            throw;
        }
        _pipe = pipe;
        _reader = new StreamReader(pipe, new UTF8Encoding(false), detectEncodingFromByteOrderMarks: false,
            bufferSize: 4096, leaveOpen: true);
        _writer = new StreamWriter(pipe, new UTF8Encoding(false), bufferSize: 4096, leaveOpen: true)
        {
            NewLine = "\n",
            AutoFlush = true,
        };
    }

    public async Task<string> QueryAsync(string command, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            StreamWriter writer = _writer ?? throw new IOException("LiveSplit pipe is not connected.");
            StreamReader reader = _reader ?? throw new IOException("LiveSplit pipe is not connected.");
            await writer.WriteLineAsync(command).ConfigureAwait(false);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromMilliseconds(1000));
            try
            {
                string? response = await reader.ReadLineAsync(timeout.Token).ConfigureAwait(false);
                return response ?? throw new IOException("LiveSplit closed the pipe.");
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                DisposeConnection();
                throw new TimeoutException($"LiveSplit did not answer '{command}'.");
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task SendAsync(string command, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            StreamWriter writer = _writer ?? throw new IOException("LiveSplit pipe is not connected.");
            await writer.WriteLineAsync(command).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    public void DisposeConnection()
    {
        var pipe = Interlocked.Exchange(ref _pipe, null);
        var reader = Interlocked.Exchange(ref _reader, null);
        var writer = Interlocked.Exchange(ref _writer, null);
        try { writer?.Dispose(); } catch (IOException) { }
        try { reader?.Dispose(); } catch (IOException) { }
        try { pipe?.Dispose(); } catch (IOException) { }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }
        DisposeConnection();
        _gate.Dispose();
    }
}
