using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace BigReplay.Live;

/// <summary>
/// Minimal RFC 6455 WebSocket server for the live replay stream. Plain <see cref="TcpListener"/>
/// rather than HttpListener/ASP.NET: the desktop app must work with no admin rights and no
/// HTTP.sys URL reservation, and the only requirements are a handshake and server-to-client text
/// frames.
///
/// Loopback by default. Nothing leaves the machine unless the caller binds a LAN address.
/// </summary>
public sealed class LiveWebSocketServer : IAsyncDisposable
{
    private const string WebSocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private const int MaxHandshakeBytes = 16 * 1024;

    private readonly TcpListener _listener;
    private readonly LiveSession _session;
    private readonly CancellationTokenSource _stop = new();
    private readonly Task _acceptLoop;
    private int _clients;

    private LiveWebSocketServer(TcpListener listener, LiveSession session, Uri url)
    {
        _listener = listener;
        _session = session;
        Url = url;
        _acceptLoop = Task.Run(AcceptLoopAsync);
    }

    /// <summary>Address clients connect to. Loopback when bound to any/unspecified address.</summary>
    public Uri Url { get; }

    public int ClientCount => Volatile.Read(ref _clients);

    /// <summary>
    /// Starts listening. <paramref name="bindAddress"/> accepts an IP literal, "localhost",
    /// "0.0.0.0"/"*" for every interface; <paramref name="port"/> 0 picks a free port.
    /// </summary>
    public static LiveWebSocketServer Start(string bindAddress, int port, LiveSession session)
    {
        ArgumentNullException.ThrowIfNull(session);
        if (port is < 0 or > 65535)
        {
            throw new ArgumentOutOfRangeException(nameof(port), port, "Port must be 0-65535.");
        }
        IPAddress address = ParseBindAddress(bindAddress);
        var listener = new TcpListener(address, port);
        listener.Start();
        int boundPort = ((IPEndPoint)listener.LocalEndpoint).Port;
        return new LiveWebSocketServer(listener, session, new Uri($"ws://{DisplayHost(address, boundPort)}/"));
    }

    public static IPAddress ParseBindAddress(string? bindAddress)
    {
        string text = (bindAddress ?? "").Trim();
        if (text.Length == 0 || text.Equals("localhost", StringComparison.OrdinalIgnoreCase))
        {
            return IPAddress.Loopback;
        }
        if (text is "*" or "+" || text.Equals("any", StringComparison.OrdinalIgnoreCase))
        {
            return IPAddress.Any;
        }
        if (IPAddress.TryParse(text, out IPAddress? parsed))
        {
            return parsed;
        }
        return IPAddress.Parse(text); // let the framework's message explain a bad literal
    }

    private static string DisplayHost(IPAddress address, int port)
    {
        if (address.Equals(IPAddress.Loopback) || address.Equals(IPAddress.IPv6Loopback))
        {
            return $"127.0.0.1:{port}";
        }
        string host = address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any)
            ? LanAddress() ?? "127.0.0.1"
            : address.ToString();
        return host.Contains(':') ? $"[{host}]:{port}" : $"{host}:{port}";
    }

    /// <summary>
    /// Best-effort LAN address for a wildcard bind. The printed address is what other people would
    /// type, and it is also how callers know the stream is reachable beyond this machine.
    /// </summary>
    private static string? LanAddress()
    {
        try
        {
            return Dns.GetHostAddresses(Dns.GetHostName())
                .FirstOrDefault(address => address.AddressFamily == AddressFamily.InterNetwork &&
                    !IPAddress.IsLoopback(address))
                ?.ToString();
        }
        catch (Exception)
        {
            return null; // no host name / no DNS: the loopback address is still a valid answer
        }
    }

    private async Task AcceptLoopAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await _listener.AcceptTcpClientAsync(_stop.Token).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is OperationCanceledException or SocketException or ObjectDisposedException)
            {
                break;
            }
            _ = Task.Run(() => ServeClientAsync(client));
        }
    }

    private async Task ServeClientAsync(TcpClient client)
    {
        Interlocked.Increment(ref _clients);
        try
        {
            client.NoDelay = true;
            client.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.KeepAlive, true);
            NetworkStream stream = client.GetStream();
            using var socket = new LiveSocket(stream);

            string? key = await ReadRequestAsync(socket, _stop.Token).ConfigureAwait(false);
            if (key is null)
            {
                return; // not a WebSocket upgrade: the request was answered with viewer content
            }
            await socket.WriteRawAsync(Encoding.ASCII.GetBytes(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                $"Sec-WebSocket-Accept: {AcceptKey(key)}\r\n\r\n"), _stop.Token).ConfigureAwait(false);

            using var stop = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
            using LiveSubscription subscription = _session.Subscribe(socket.WriteText);
            Task reader = ReadClientLoopAsync(socket, subscription, stop.Token);
            await Task.WhenAny(subscription.Completion, reader).ConfigureAwait(false);
            stop.Cancel();
            subscription.Dispose();
            socket.Abort();
            await Task.WhenAny(reader, Task.Delay(TimeSpan.FromMilliseconds(250))).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // One client's socket misbehaving must never affect the capture loop or other viewers.
        }
        finally
        {
            client.Dispose();
            Interlocked.Decrement(ref _clients);
        }
    }

    /// <summary>
    /// Reads the request head. A WebSocket upgrade returns its key; anything else is a plain HTTP
    /// request, answered here with the bundled viewer (or an explanation) and returns null.
    /// </summary>
    private static async Task<string?> ReadRequestAsync(LiveSocket socket, CancellationToken token)
    {
        byte[] head = new byte[MaxHandshakeBytes];
        int length = 0;
        while (true)
        {
            if (length == head.Length)
            {
                return null;
            }
            int read = await socket.ReadAsync(head.AsMemory(length), token).ConfigureAwait(false);
            if (read <= 0)
            {
                return null;
            }
            length += read;
            int terminator = IndexOfHeaderEnd(head, length);
            if (terminator < 0)
            {
                continue;
            }
            socket.Prefetch(head, terminator, length);
            string request = Encoding.ASCII.GetString(head, 0, terminator);
            string[] requestLine = request.Split('\n', 2)[0].Trim().Split(' ');
            string method = requestLine.Length > 0 ? requestLine[0] : "";
            string target = requestLine.Length > 1 ? requestLine[1] : "/";
            string? key = HeaderValue(request, "Sec-WebSocket-Key");
            bool upgrade = (HeaderValue(request, "Upgrade") ?? "")
                .Contains("websocket", StringComparison.OrdinalIgnoreCase);
            if (key is not null && upgrade && string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase))
            {
                return key;
            }
            await WriteHttpResponseAsync(socket, method, target, token).ConfigureAwait(false);
            return null;
        }
    }

    /// <summary>Serves one bundled viewer file. Same port as the stream, so the page and the
    /// WebSocket share an origin and no browser blocks the connection.</summary>
    private static async Task WriteHttpResponseAsync(LiveSocket socket, string method, string target,
        CancellationToken token)
    {
        bool bodyAllowed = string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase);
        bool headOnly = string.Equals(method, "HEAD", StringComparison.OrdinalIgnoreCase);
        if (!bodyAllowed && !headOnly)
        {
            await socket.WriteRawAsync(Encoding.UTF8.GetBytes(
                TextResponse(405, "Method Not Allowed", "Only GET is supported here.\n")), token).ConfigureAwait(false);
            return;
        }
        if (!ViewerAssets.TryGet(target, out string contentType, out byte[] body))
        {
            const string hint =
                "Big Replay live server\n\n" +
                "The viewer is served on this port: open http://<this address>/ (for example\n" +
                "http://127.0.0.1:8787/) and it connects to the live stream automatically.\n";
            await socket.WriteRawAsync(Encoding.UTF8.GetBytes(
                TextResponse(404, "Not Found", hint)), token).ConfigureAwait(false);
            return;
        }
        string header = "HTTP/1.1 200 OK\r\n" +
            $"Content-Type: {contentType}\r\n" +
            $"Content-Length: {body.Length}\r\n" +
            "Cache-Control: no-cache\r\n" +
            "Connection: close\r\n\r\n";
        byte[] headerBytes = Encoding.ASCII.GetBytes(header);
        byte[] response = new byte[headerBytes.Length + (headOnly ? 0 : body.Length)];
        headerBytes.CopyTo(response, 0);
        if (!headOnly)
        {
            body.CopyTo(response, headerBytes.Length);
        }
        await socket.WriteRawAsync(response, token).ConfigureAwait(false);
    }

    private static string TextResponse(int status, string reason, string text)
    {
        return $"HTTP/1.1 {status} {reason}\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            $"Content-Length: {Encoding.UTF8.GetByteCount(text)}\r\n" +
            "Connection: close\r\n\r\n" + text;
    }

    private static int IndexOfHeaderEnd(byte[] buffer, int length)
    {
        for (int i = 3; i < length; i++)
        {
            if (buffer[i] == '\n' && buffer[i - 1] == '\r' && buffer[i - 2] == '\n' && buffer[i - 3] == '\r')
            {
                return i + 1;
            }
        }
        return -1;
    }

    private static string? HeaderValue(string request, string name)
    {
        foreach (string line in request.Split('\n'))
        {
            int colon = line.IndexOf(':');
            if (colon <= 0 || !line.AsSpan(0, colon).Trim().Equals(name, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            return line.AsSpan(colon + 1).Trim().ToString();
        }
        return null;
    }

    private static string AcceptKey(string key) => Convert.ToBase64String(
        SHA1.HashData(Encoding.ASCII.GetBytes(key + WebSocketGuid)));

    private static async Task ReadClientLoopAsync(LiveSocket socket, LiveSubscription subscription, CancellationToken token)
    {
        while (!token.IsCancellationRequested && !subscription.Overflowed)
        {
            (byte opcode, byte[] payload)? frame = await socket.ReadFrameAsync(token).ConfigureAwait(false);
            if (frame is null)
            {
                return; // client closed
            }
            switch (frame.Value.opcode)
            {
                case 0x8: // close
                    return;
                case 0x9: // ping
                    await socket.SendAsync(0xA, frame.Value.payload, token).ConfigureAwait(false);
                    break;
                default:
                    break; // the viewer never sends replay data; ignore text/binary/pong
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        _listener.Stop();
        try
        {
            await _acceptLoop.ConfigureAwait(false);
        }
        catch (Exception)
        {
            // accept loop already finished
        }
        _stop.Dispose();
    }
}

/// <summary>Buffered socket reads plus RFC 6455 framing for a single client.</summary>
internal sealed class LiveSocket(NetworkStream stream) : IDisposable
{
    /// <summary>A viewer never sends replay data; anything larger is a protocol violation.</summary>
    private const int MaxClientPayloadBytes = 64 * 1024;

    private readonly NetworkStream _stream = stream;
    private readonly SemaphoreSlim _writeGate = new(1, 1);
    private byte[] _pending = new byte[16 * 1024];
    private int _pendingStart;
    private int _pendingEnd;

    /// <summary>Keeps bytes read past the handshake: they are already frame data.</summary>
    public void Prefetch(byte[] buffer, int start, int end)
    {
        _pending = buffer;
        _pendingStart = start;
        _pendingEnd = end;
    }

    public async Task<int> ReadAsync(Memory<byte> destination, CancellationToken token)
    {
        int copied = Drain(destination.Span);
        if (copied > 0)
        {
            return copied;
        }
        return await _stream.ReadAsync(destination, token).ConfigureAwait(false);
    }

    private int Drain(Span<byte> destination)
    {
        int available = _pendingEnd - _pendingStart;
        if (available <= 0)
        {
            return 0;
        }
        int count = Math.Min(available, destination.Length);
        _pending.AsSpan(_pendingStart, count).CopyTo(destination);
        _pendingStart += count;
        if (_pendingStart == _pendingEnd)
        {
            _pendingStart = _pendingEnd = 0;
        }
        return count;
    }

    private async Task<bool> ReadExactAsync(Memory<byte> destination, CancellationToken token)
    {
        int filled = 0;
        while (filled < destination.Length)
        {
            int read = await ReadAsync(destination[filled..], token).ConfigureAwait(false);
            if (read <= 0)
            {
                return false;
            }
            filled += read;
        }
        return true;
    }

    /// <summary>Reads one client frame. Returns null at end of stream or on a protocol violation.</summary>
    public async Task<(byte Opcode, byte[] Payload)?> ReadFrameAsync(CancellationToken token)
    {
        byte[] head = new byte[2];
        if (!await ReadExactAsync(head, token).ConfigureAwait(false))
        {
            return null;
        }
        byte opcode = (byte)(head[0] & 0x0F);
        bool masked = (head[1] & 0x80) != 0;
        ulong length = (ulong)(head[1] & 0x7F);
        if (length == 126)
        {
            byte[] extended = new byte[2];
            if (!await ReadExactAsync(extended, token).ConfigureAwait(false))
            {
                return null;
            }
            length = (ulong)((extended[0] << 8) | extended[1]);
        }
        else if (length == 127)
        {
            byte[] extended = new byte[8];
            if (!await ReadExactAsync(extended, token).ConfigureAwait(false))
            {
                return null;
            }
            length = 0;
            foreach (byte b in extended)
            {
                length = (length << 8) | b;
            }
        }
        if (length > MaxClientPayloadBytes)
        {
            return null; // a viewer never sends anything large: treat as a hostile client
        }
        byte[] mask = new byte[4];
        if (masked && !await ReadExactAsync(mask, token).ConfigureAwait(false))
        {
            return null;
        }
        byte[] payload = new byte[(int)length];
        if (payload.Length > 0 && !await ReadExactAsync(payload, token).ConfigureAwait(false))
        {
            return null;
        }
        if (masked)
        {
            for (int i = 0; i < payload.Length; i++)
            {
                payload[i] ^= mask[i & 3];
            }
        }
        return (opcode, payload);
    }

    /// <summary>Writes a text frame. Called from the subscription pump: returns false when gone.</summary>
    public bool WriteText(string line)
    {
        try
        {
            _writeGate.Wait();
            try
            {
                _stream.Write(Encode(0x1, Encoding.UTF8.GetBytes(line)));
                return true;
            }
            finally
            {
                _writeGate.Release();
            }
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or SocketException)
        {
            return false;
        }
    }

    public async Task SendAsync(byte opcode, ReadOnlyMemory<byte> payload, CancellationToken token)
    {
        await _writeGate.WaitAsync(token).ConfigureAwait(false);
        try
        {
            await _stream.WriteAsync(Encode(opcode, payload.Span), token).ConfigureAwait(false);
        }
        finally
        {
            _writeGate.Release();
        }
    }

    public async Task WriteRawAsync(byte[] bytes, CancellationToken token)
    {
        await _writeGate.WaitAsync(token).ConfigureAwait(false);
        try
        {
            await _stream.WriteAsync(bytes, token).ConfigureAwait(false);
            await _stream.FlushAsync(token).ConfigureAwait(false);
        }
        finally
        {
            _writeGate.Release();
        }
    }

    private static byte[] Encode(byte opcode, ReadOnlySpan<byte> payload)
    {
        int headerLength = payload.Length <= 125 ? 2 : payload.Length <= ushort.MaxValue ? 4 : 10;
        byte[] frame = new byte[headerLength + payload.Length];
        frame[0] = (byte)(0x80 | opcode);
        if (payload.Length <= 125)
        {
            frame[1] = (byte)payload.Length;
        }
        else if (payload.Length <= ushort.MaxValue)
        {
            frame[1] = 126;
            frame[2] = (byte)(payload.Length >> 8);
            frame[3] = (byte)payload.Length;
        }
        else
        {
            frame[1] = 127;
            ulong length = (ulong)payload.Length;
            for (int i = 0; i < 8; i++)
            {
                frame[2 + i] = (byte)(length >> (56 - (8 * i)));
            }
        }
        payload.CopyTo(frame.AsSpan(headerLength));
        return frame;
    }

    /// <summary>Drops the connection so a blocked read or write fails immediately.</summary>
    public void Abort()
    {
        try
        {
            _stream.Dispose();
        }
        catch (Exception)
        {
            // already gone
        }
    }

    public void Dispose()
    {
        Abort();
        _writeGate.Dispose();
    }
}