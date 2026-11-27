#:project ../Replay.Format.csproj
#:property PublishAot=false
using System.IO.Compression;
using System.Text.Json;
using Replay.Format;

static void Check(bool ok, string message)
{
    if (!ok) throw new InvalidDataException(message);
}

var header = new ReplayHeader
{
    GameVersion = "game", UnityVersion = "unity", RecordedAt = DateTime.UnixEpoch,
    SampleIntervalSec = .1, Landmarks = [new Landmark { Id = "place", Label = "雪\n!" }],
};
var ev = new ReplayEvent { Time = .25, Type = "join", Detail = "\"\n" };
var output = new CaptureStream();
using var writer = new ReplayWriter(output);
int cursor = 0, records = 0;
JsonElement TakeRecord(string kind)
{
    int end = (int)output.Length;
    Check(end > cursor && output.GetBuffer()[end - 1] == '\n', $"unterminated {kind}");
    Check(output.Flushes == ++records, $"unflushed {kind}");
    using var doc = JsonDocument.Parse(output.GetBuffer().AsMemory(cursor, end - cursor - 1));
    cursor = end;
    return doc.RootElement.EnumerateObject().Single(p => p.NameEquals(kind)).Value.Clone();
}
writer.WriteHeader(header);
var storedHeader = TakeRecord("header");
Check(header.FormatVersion == 1 && storedHeader.GetProperty("formatVersion").GetInt32() == 2, "live/file versions");
writer.WriteEvent(ev);
Check(TakeRecord("event").GetRawText() == JsonSerializer.Serialize(ev, ReplayJson.Options), "event not published immediately");
int headerAndEventBytes = cursor;

var p = new PlayerSnapshot { NetId = 1 };
var g = new GourdSnapshot { Name = 100 };
var m = new MonumentSnapshot { HomeName = 101 };
List<PlayerSnapshot> players = [p];
List<GourdSnapshot> gourds = [g];
List<MonumentSnapshot> monuments = [m];
string[] names = ["players", "gourds", "monuments"];
var state = names.ToDictionary(n => n, _ => new List<string>());
int tick = 0;
ReplayFrame Frame() => new() { Time = tick / 10.0, Players = players, Gourds = gourds, Monuments = monuments };
void Sample()
{
    ReplayFrame frame = Frame();
    writer.WriteFrame(frame);
    JsonElement patchFrame = TakeRecord("frame");
    JsonElement dense = JsonSerializer.SerializeToElement(frame, ReplayJson.Options);
    Check(patchFrame.GetProperty("time").GetRawText() == dense.GetProperty("time").GetRawText(), "time");
    foreach (string name in names)
    {
        List<string> reconstructed = state[name];
        string[] expected = dense.GetProperty(name).EnumerateArray().Select(x => x.GetRawText()).ToArray();
        bool patched = patchFrame.TryGetProperty(name, out var patch);
        Check(patched != reconstructed.SequenceEqual(expected), $"redundant/missing {name} at tick {tick}");
        if (!patched) continue;
        int length = patch[0].GetInt32();
        Check(length == expected.Length, $"{name} length");
        if (length < reconstructed.Count) reconstructed.RemoveRange(length, reconstructed.Count - length);
        while (reconstructed.Count < length) reconstructed.Add("");
        int last = -1;
        for (int i = 1; i < patch.GetArrayLength(); i += 2)
        {
            int index = patch[i].GetInt32();
            string replacement = patch[i + 1].GetRawText();
            Check(index > last && index < length && reconstructed[index] != replacement, $"redundant/invalid {name} index");
            reconstructed[index] = replacement;
            last = index;
        }
        Check(reconstructed.SequenceEqual(expected), $"{name} mismatch at tick {tick}");
    }
    tick++;
}

Sample(); Sample(); // Initial full state, then only time. Reuse mutable objects throughout.
players[0] = p = new PlayerSnapshot { NetId = 2 }; Sample();
players[0] = p = new PlayerSnapshot { NetId = 2, Name = "☁\n" }; Sample();
p.X = BitConverter.Int32BitsToSingle(int.MinValue); Sample(); // -0 is distinct from +0 in JSON.
p.Y = MathF.BitIncrement(0); Sample();
p.Z = float.NaN; Sample();
p.Yaw = float.PositiveInfinity; Sample();
p.Alive = true; Sample(); p.IsPending = true; Sample(); p.Drowsy = true; Sample(); p.CarriedGourd = 4; Sample();
gourds[0] = g = new GourdSnapshot { Name = 101 }; Sample();
g.X = 1; Sample(); g.Y = 2; Sample(); g.Z = 3; Sample(); g.State = 2; Sample();
g.PinnedAtHome = 7; Sample(); g.HolderNetId = uint.MaxValue; Sample();
monuments[0] = m = new MonumentSnapshot { HomeName = 102 }; Sample(); m.Filled = true; Sample();
gourds.Add(new GourdSnapshot { Name = g.Name, X = 12 }); Sample(); // duplicate identity
(gourds[0], gourds[1]) = (gourds[1], gourds[0]); Sample();
gourds.RemoveAt(1); Sample();

p.CarriedGourd = 8; // Stage a real change before an invalid collection entry aborts this sample.
gourds.Add(null!);
try { writer.WriteFrame(Frame()); throw new InvalidDataException("accepted invalid sample"); }
catch (NullReferenceException) { }
Check(output.Length == cursor, "failed record leaked bytes");
gourds.RemoveAt(1);
Sample(); // Must still emit the player change relative to the last *successful* frame.
players.Clear(); gourds.Clear(); monuments.Clear(); Sample(); Sample();

using var compressed = new MemoryStream();
using (var zipWriter = new ReplayWriter(compressed, gzip: true))
{
    zipWriter.WriteHeader(header);
    zipWriter.WriteEvent(ev);
}
using var inflater = new GZipStream(new MemoryStream(compressed.ToArray()), CompressionMode.Decompress);
using var uncompressed = new MemoryStream();
inflater.CopyTo(uncompressed);
Check(uncompressed.ToArray().AsSpan().SequenceEqual(output.GetBuffer().AsSpan(0, headerAndEventBytes)), "gzip wire format");

output.FailFlush = true;
try { writer.WriteEvent(ev); throw new InvalidDataException("swallowed I/O failure"); }
catch (IOException ex) when (ex.Message == "disk full") { }
Console.WriteLine($"Writer contract OK: {tick} sparse frames decoded exactly.");

sealed class CaptureStream : MemoryStream
{
    public int Flushes { get; private set; }
    public bool FailFlush { get; set; }
    public override void Flush()
    {
        if (FailFlush) throw new IOException("disk full");
        Flushes++;
        base.Flush();
    }
}
