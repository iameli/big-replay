using System.IO.Compression;
using System.Text.Json;

namespace Replay.Format;

/// <summary>
/// Replay writer: gzip-compressed JSON stream {header, frames[], events[]}.
/// </summary>
public sealed class ReplayWriter : IDisposable
{
    private static readonly JsonSerializerOptions Json = ReplayJson.Options;

    private readonly GZipStream _gz;
    private readonly StreamWriter _sw;

    public ReplayWriter(Stream output)
    {
        _gz = new GZipStream(output, CompressionLevel.Fastest);
        _sw = new StreamWriter(_gz) { NewLine = "\n" };
    }

    public void WriteHeader(ReplayHeader header)
    {
        _sw.Write("{\"header\":");
        _sw.Write(JsonSerializer.Serialize(header, Json));
        _sw.Write(",\"frames\":[");
    }
    public void WriteFrame(ReplayFrame frame)
    {
        // Serialize the frame BEFORE emitting the array delimiter: a mid-frame failure must
        // never strand a trailing "," (a crashed frame then leaves a clean "]" from Finish).
        string json = JsonSerializer.Serialize(frame, Json);
        if (!_first)
        {
            _sw.Write(',');
        }
        _first = false;
        _sw.Write(json);
        _sw.Flush();
    }
    private bool _first = true;

    public void Finish(List<ReplayEvent>? events = null)
    {
        _sw.Write("],\"events\":");
        _sw.Write(JsonSerializer.Serialize(events ?? [], Json));
        _sw.Write('}');
        _sw.Flush();
    }

    public void Dispose()
    {
        _sw.Dispose();
    }
}