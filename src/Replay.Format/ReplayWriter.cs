using System.Buffers;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Replay.Format;

/// <summary>
/// Writes one UTF-8 JSON line per published record, optionally wrapped in gzip. Owns the stream.
/// </summary>
public sealed class ReplayWriter : IDisposable
{
    private readonly Stream _output;
    private readonly ArrayBufferWriter<byte> _buffer = new();
    private readonly Utf8JsonWriter _json;
    private bool _hasHeader;

    // Snapshot value keys rather than retaining the caller's mutable objects. Float bits preserve
    // changes as small as the sign of zero. No per-item allocation or serialization when idle.
    private readonly record struct PlayerKey(uint Id, string? Name, int X, int Y, int Z, int Yaw,
        bool Alive, bool Pending, bool Drowsy, int CarriedGourd);
    private readonly record struct GourdKey(int Name, int X, int Y, int Z, int State, int Home, uint Holder);
    private static int Bits(float value) => BitConverter.SingleToInt32Bits(value);
    private readonly Patch<PlayerSnapshot, PlayerKey> _players = new(p => new(
        p.NetId, p.Name, Bits(p.X), Bits(p.Y), Bits(p.Z), Bits(p.Yaw), p.Alive, p.IsPending, p.Drowsy, p.CarriedGourd));
    private readonly Patch<GourdSnapshot, GourdKey> _gourds = new(g => new(
        g.Name, Bits(g.X), Bits(g.Y), Bits(g.Z), g.State, g.PinnedAtHome, g.HolderNetId));
    private readonly Patch<MonumentSnapshot, (int, bool)> _monuments = new(m => (m.HomeName, m.Filled));

    public ReplayWriter(Stream output, bool gzip = false)
    {
        _output = gzip ? new GZipStream(output, CompressionLevel.Fastest) : output;
        _json = new Utf8JsonWriter(_buffer);
    }

    public void WriteHeader(ReplayHeader header)
    {
        if (_hasHeader) throw new InvalidOperationException("Replay already has a header.");
        BeginRecord("header"u8);
        JsonSerializer.Serialize(_json, header with { FormatVersion = ReplayFile.Version }, ReplayJson.Options);
        EndRecord();
        _hasHeader = true;
    }

    public void WriteEvent(ReplayEvent replayEvent)
    {
        RequireHeader();
        BeginRecord("event"u8);
        JsonSerializer.Serialize(_json, replayEvent, ReplayJson.Options);
        EndRecord();
    }

    public void WriteFrame(ReplayFrame frame)
    {
        RequireHeader();
        BeginRecord("frame"u8);
        _json.WriteStartObject();
        _json.WritePropertyName("time"u8);
        JsonSerializer.Serialize(_json, frame.Time, ReplayJson.Options);
        try
        {
            _players.Write(_json, "players"u8, frame.Players);
            _gourds.Write(_json, "gourds"u8, frame.Gourds);
            _monuments.Write(_json, "monuments"u8, frame.Monuments);
            _json.WriteEndObject();
            EndRecord();

            _players.Commit(frame.Players.Count);
            _gourds.Commit(frame.Gourds.Count);
            _monuments.Commit(frame.Monuments.Count);
        }
        finally
        {
            _players.ClearPending();
            _gourds.ClearPending();
            _monuments.ClearPending();
        }
    }

    private void RequireHeader()
    {
        if (!_hasHeader) throw new InvalidOperationException("Write the replay header first.");
    }

    private void BeginRecord(ReadOnlySpan<byte> name)
    {
        _buffer.ResetWrittenCount();
        _json.Reset(_buffer);
        _json.WriteStartObject();
        _json.WritePropertyName(name);
    }

    private void EndRecord()
    {
        _json.WriteEndObject();
        _json.Flush();
        _buffer.GetSpan(1)[0] = (byte)'\n';
        _buffer.Advance(1);
        // If serialization failed, not even the beginning of this line reached the file.
        _output.Write(_buffer.WrittenSpan);
        _output.Flush();
    }

    public void Dispose()
    {
        _json.Dispose();
        _output.Dispose();
    }

    private sealed class Patch<T, TKey>(Func<T, TKey> keyOf) where TKey : struct, IEquatable<TKey>
    {
        private readonly List<TKey> _previous = [];
        private readonly List<(int Index, TKey Key)> _pending = [];

        public void Write(Utf8JsonWriter json, ReadOnlySpan<byte> name, List<T> current)
        {
            // Stage only the changed slots; do not mutate the baseline until the entire frame
            // (including its other collections) has been serialized, written and flushed.
            for (int i = 0; i < current.Count; i++)
            {
                T item = current[i];
                TKey key = keyOf(item);
                if (i < _previous.Count && key.Equals(_previous[i])) continue;
                _pending.Add((i, key));
            }
            if (_pending.Count == 0 && current.Count == _previous.Count) return;
            json.WriteStartArray(name);
            json.WriteNumberValue(current.Count);
            foreach (var (index, _) in _pending)
            {
                json.WriteNumberValue(index);
                JsonSerializer.Serialize(json, current[index], ReplayJson.Options);
            }
            json.WriteEndArray();
        }

        public void Commit(int count)
        {
            if (count != _previous.Count) CollectionsMarshal.SetCount(_previous, count);
            foreach (var (index, key) in _pending) _previous[index] = key;
        }

        public void ClearPending() => _pending.Clear();
    }
}