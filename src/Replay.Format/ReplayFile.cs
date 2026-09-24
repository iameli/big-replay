namespace Replay.Format;

/// <summary>Replay file format version. Bump on breaking schema changes; keep the viewer in sync.</summary>
public static class ReplayFile
{
    public const int Version = 1;
}

public sealed class ReplayHeader
{
    public int FormatVersion { get; init; } = ReplayFile.Version;
    public required string GameVersion { get; init; }
    public required string UnityVersion { get; init; }
    public required DateTime RecordedAt { get; init; }
    public double SampleIntervalSec { get; init; }
    public required List<Landmark> Landmarks { get; init; }
}

/// <summary>A fixed world-space reference recorded at session start so the viewer can draw a schematic map.</summary>
public sealed class Landmark
{
    public required string Id { get; init; }
    public required string Label { get; init; }
    public float X { get; set; }
    public float Y { get; set; }
    public float Z { get; set; }
}

public sealed class PlayerSnapshot
{
    public required uint NetId { get; init; }
    public float X { get; set; }
    public float Y { get; set; }
    public float Z { get; set; }
    public float Yaw { get; set; }
    public bool Alive { get; set; }
    public bool IsPending { get; set; }
    public bool Drowsy { get; set; }
    /// <summary>saveablePropName of the gourd this player carries (0 = none).</summary>
    public int CarriedGourd { get; set; }
}

/// <summary>Gourd state: 0 locked (at rest / unreachable), 1 loose (in world), 2 stashed (in a pocket), 3 pinned (monument slot filled).</summary>
public static class GourdState
{
    public const int Locked = 0;
    public const int Loose = 1;
    public const int Stashed = 2;
    public const int Pinned = 3;
}

public sealed class GourdSnapshot
{
    /// <summary>SaveablePropName value (e.g. 100 = gourdCabinFever).</summary>
    public required int Name { get; init; }
    public float X { get; set; }
    public float Y { get; set; }
    public float Z { get; set; }
    public int State { get; set; }
    /// <summary>SaveableHomeName of the monument slot when pinned, else 0.</summary>
    public int PinnedAtHome { get; set; }
    /// <summary>NetId of the carrying player when stashed, else 0.</summary>
    public uint HolderNetId { get; set; }
}

public sealed class MonumentSnapshot
{
    /// <summary>SaveableHomeName value (100..177).</summary>
    public required int HomeName { get; init; }
    public bool Filled { get; set; }
}

public sealed class ReplayFrame
{
    public required double Time { get; init; }
    public required List<PlayerSnapshot> Players { get; init; }
    public required List<GourdSnapshot> Gourds { get; init; }
    public required List<MonumentSnapshot> Monuments { get; init; }
}

public sealed class ReplayEvent
{
    public required double Time { get; init; }
    public required string Type { get; init; }
    public string? Detail { get; init; }
}