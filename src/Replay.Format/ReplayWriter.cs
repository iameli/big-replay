using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Replay.Format;

/// <summary>
/// Replay writer: gzip-compressed JSON stream {header, frames[], events[]}.
/// </summary>
public sealed class ReplayWriter
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

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
        if (_first)
        {
            _first = false;
        }
        else
        {
            _sw.Write(',');
        }
        _sw.Write(JsonSerializer.Serialize(frame, Json));
    }

    private bool _first = true;

    public void Finish(List<ReplayEvent>? events = null)
    {
        _sw.Write("],\"events\":");
        _sw.Write(JsonSerializer.Serialize(events ?? [], Json));
        _sw.Write('}');
        _sw.Flush();
        _gz.Dispose();
    }
}