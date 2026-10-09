using System.Text.Json;
using System.Text.Json.Serialization;

namespace Replay.Format;

/// <summary>
/// One set of serializer settings for every replay-shaped payload: the gzip file, the live
/// WebSocket stream, and anything else that hands frames to the viewer. Keeping them in one
/// place is what makes "a live frame is a file frame" true rather than aspirational.
/// </summary>
public static class ReplayJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        // a stray NaN/Infinity from a bad read must never kill a run: serialize as a literal
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
    };
}