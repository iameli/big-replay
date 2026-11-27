using System.Text.Json;
using System.Text.Json.Serialization;

namespace Replay.Format;

/// <summary>
/// Shared serialization of logical replay values in both the sparse file and full-frame live stream.
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