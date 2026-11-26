using System.Text.RegularExpressions;

namespace Replay.Format;

/// <summary>One tower's contiguous range in the shared receptacle table.</summary>
public sealed record GourdTowerGroup(string Name, int Start, int Count);

/// <summary>A tower becoming full on one completed replay frame.</summary>
public sealed record TowerCompletion(string Tower, int GroupIndex, double Time, long Frame, int Filled, int Total);

/// <summary>
/// Fixed gourd receptacles measured from the completed 1.5.1 reconciled run.
/// Kept byte-for-byte in step with <c>gourd-receptacles.js</c>; the parity test in
/// <c>scripts/gourd-receptacles-parity.test.cjs</c> fails if the two tables drift.
/// Slots are positions, not gourd IDs: any gourd can fill any receptacle.
/// </summary>
public static class GourdReceptacles
{
    public const double Tolerance = 0.01; // One centimetre in XYZ, not map proximity.

    private static readonly string[] GroupNames =
    [
        "Tutorial", "Red", "Green", "Blue", "Yellow", "Black", "Storage",
    ];

    private static readonly double[][] GroupPositions =
    [
        // Tutorial
        [
            -378.0273, 3.1100001, -710.4163,
            -377.8072, 3.1100001, -709.85815,
            -377.58707, 3.1100001, -709.3,
            -377.3669, 3.1100001, -708.7418,
        ],
        // Red
        [
            -90.71129, 101.369995, -605.85815,
            -90.13241, 101.369995, -605.59735,
            -89.52607, 101.369995, -605.40906,
            -88.9013, 101.369995, -605.2961,
            -88.26742, 101.369995, -605.2601,
        ],
        // Green
        [
            450.72235, 116.909996, -448.64194,
            451.03647, 116.909996, -449.1937,
            451.41547, 116.909996, -449.70306,
            451.85373, 116.909996, -450.16245,
            452.3447, 116.909996, -450.565,
        ],
        // Blue
        [
            139.21765, 116.729996, -197.96428,
            139.8495, 116.729996, -198.02646,
            140.46907, 116.729996, -198.16519,
            141.06711, 116.729996, -198.37839,
            141.6347, 116.729996, -198.66287,
        ],
        // Yellow
        [
            -232.68297, 135.9, -241.8549,
            -232.22488, 135.9, -242.29454,
            -231.71666, 135.9, -242.67506,
            -231.16583, 135.9, -242.99081,
            -230.58064, 135.9, -243.23708,
        ],
        // Black
        [
            -32.255337, 117.32, -285.98932,
            -31.869665, 117.32, -285.5297,
            -31.483994, 117.32, -285.07007,
            -31.09832, 117.32, -284.6104,
            -30.712646, 117.32, -284.1508,
            -30.326975, 117.32, -283.69116,
        ],
        // Storage
        [
            -122.04227, 46.1063, -444.98605,
            -121.725685, 46.1063, -445.76334,
            -121.5346, 46.1063, -446.58054,
            -128.45128, 47.1063, -440.68274,
            -127.622215, 47.1063, -440.53415,
            -126.78123, 47.1063, -440.4877,
            -124.27566, 47.1063, -453.79724,
            -123.513306, 47.1063, -453.43912,
            -122.80028, 47.1063, -452.99078,
            -122.83191, 48.1063, -441.75864,
            -122.17584, 48.1063, -442.28687,
            -121.58905, 48.1063, -442.89108,
            -120.31282, 48.1063, -449.6704,
            -120.08294, 48.1063, -448.8601,
            -119.95352, 48.1063, -448.02783,
        ],
    ];

    public readonly record struct Slot(double X, double Y, double Z);

    public static readonly IReadOnlyList<GourdTowerGroup> Groups;
    public static readonly IReadOnlyList<Slot> Slots;
    public static readonly int[] SlotGroups;

    static GourdReceptacles()
    {
        var groups = new List<GourdTowerGroup>(GroupNames.Length);
        var slots = new List<Slot>();
        var slotGroups = new List<int>();
        for (int g = 0; g < GroupNames.Length; g++)
        {
            double[] raw = GroupPositions[g];
            if (raw.Length % 3 != 0)
            {
                throw new InvalidOperationException($"Receptacle group {GroupNames[g]} is not XYZ triples.");
            }
            int start = slots.Count;
            for (int i = 0; i < raw.Length; i += 3)
            {
                slots.Add(new Slot(raw[i], raw[i + 1], raw[i + 2]));
                slotGroups.Add(g);
            }
            groups.Add(new GourdTowerGroup(GroupNames[g], start, slots.Count - start));
        }
        Groups = groups;
        Slots = slots;
        SlotGroups = slotGroups.ToArray();
    }

    /// <summary>Index of the first receptacle within one centimetre of the gourd, or -1.</summary>
    public static int SlotAt(float x, float y, float z)
    {
        const double radius2 = Tolerance * Tolerance;
        for (int i = 0; i < Slots.Count; i++)
        {
            var slot = Slots[i];
            double dx = (double)x - slot.X;
            double dy = (double)y - slot.Y;
            double dz = (double)z - slot.Z;
            if (dx * dx + dy * dy + dz * dz <= radius2)
            {
                return i;
            }
        }
        return -1;
    }

    public static int SlotAt(GourdSnapshot gourd) => SlotAt(gourd.X, gourd.Y, gourd.Z);

    public static bool IsColoredTower(string tower) =>
        tower is "Red" or "Green" or "Blue" or "Yellow";
}

/// <summary>
/// Live-replay form of <c>GourdReceptacles</c>: current occupancy only, no seek history.
/// Missing observations (including the empty shutdown frame) retain the last known placement;
/// an observed move away clears it. Completions are evaluated once per group per whole frame.
/// </summary>
public sealed class TowerProgressTracker
{
    private readonly object _gate = new();
    private readonly int?[] _occupants = new int?[GourdReceptacles.Slots.Count];
    private readonly Dictionary<int, int> _locations = new();
    private readonly bool[] _complete = new bool[GourdReceptacles.Groups.Count];
    private bool _suppressFirstFrameCompletions;
    private bool _hasData;
    private long _frames;
    private long _session;

    public bool HasData
    {
        get { lock (_gate) return _hasData; }
    }

    public long Frames
    {
        get { lock (_gate) return _frames; }
    }

    /// <summary>Increments on every reset so a coordinator can tell one recording session
    /// from the next even when both are reporting frames.</summary>
    public long Session
    {
        get { lock (_gate) return _session; }
    }

    /// <summary>Clear occupancy. <paramref name="suppressFirstFrameCompletions"/> baselines
    /// whatever is already full on the first frame after a session starts (attach/late join).</summary>
    public void Reset(bool suppressFirstFrameCompletions = false)
    {
        lock (_gate)
        {
            Array.Clear(_occupants);
            _locations.Clear();
            Array.Clear(_complete);
            _suppressFirstFrameCompletions = suppressFirstFrameCompletions;
            _hasData = false;
            _frames = 0;
            _session++;
        }
    }

    /// <summary>Start a recording session. A tower already full on the first frame is a
    /// baseline, not a split.</summary>
    public void BeginSession() => Reset(suppressFirstFrameCompletions: true);

    /// <summary>Names of towers whose every receptacle is currently occupied.</summary>
    public IReadOnlyList<string> CompletedTowers()
    {
        lock (_gate)
        {
            var result = new List<string>();
            for (int i = 0; i < GourdReceptacles.Groups.Count; i++)
            {
                if (_complete[i])
                {
                    result.Add(GourdReceptacles.Groups[i].Name);
                }
            }
            return result;
        }
    }

    /// <summary>Copy of current slot occupancy (gourd name per slot, null when empty).</summary>
    public int?[] SnapshotOccupants()
    {
        lock (_gate)
        {
            return (int?[])_occupants.Clone();
        }
    }

    /// <summary>Process one completed frame and return towers that just became full.</summary>
    public IReadOnlyList<TowerCompletion> ScanFrame(ReplayFrame frame, long frameIndex)
    {
        lock (_gate)
        {
            bool suppress = _suppressFirstFrameCompletions;
            _suppressFirstFrameCompletions = false;
            _hasData = true;

            foreach (var gourd in frame.Gourds)
            {
                int slot = GourdReceptacles.SlotAt(gourd);
                bool hadPrevious = _locations.TryGetValue(gourd.Name, out int previous);
                if (hadPrevious && previous != slot && _occupants[previous] == gourd.Name)
                {
                    _occupants[previous] = null;
                }
                if (slot >= 0)
                {
                    _occupants[slot] = gourd.Name;
                    _locations[gourd.Name] = slot;
                }
                else
                {
                    _locations.Remove(gourd.Name);
                }
            }

            List<TowerCompletion>? completions = null;
            for (int i = 0; i < GourdReceptacles.Groups.Count; i++)
            {
                var group = GourdReceptacles.Groups[i];
                int filled = 0;
                for (int slot = group.Start; slot < group.Start + group.Count; slot++)
                {
                    if (_occupants[slot] is not null)
                    {
                        filled++;
                    }
                }
                bool complete = filled == group.Count;
                if (complete && !_complete[i] && !suppress)
                {
                    completions ??= [];
                    completions.Add(new TowerCompletion(group.Name, i, frame.Time, frameIndex,
                        filled, group.Count));
                }
                _complete[i] = complete;
            }

            _frames = frameIndex + 1;
            return completions ?? (IReadOnlyList<TowerCompletion>)Array.Empty<TowerCompletion>();
        }
    }
}

/// <summary>Maps a LiveSplit segment name onto the tower it accepts.</summary>
public static class TowerSegmentRoute
{
    private static readonly Regex GenericTower = new(@"^tower\d+$", RegexOptions.Compiled);

    private static string Normalize(string name) =>
        new(name.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());

    /// <summary>True when this LiveSplit segment's name accepts the given completed tower.</summary>
    public static bool Accepts(string segmentName, string tower)
    {
        string n = Normalize(segmentName);
        if (n.Length == 0)
        {
            return false;
        }
        if (n.Contains("tutorial"))
        {
            return tower == "Tutorial";
        }
        if (n.Contains("black") || (n.Contains("final") && n.Contains("tower")))
        {
            return tower == "Black";
        }
        if (n.Contains("storage") || n.Contains("screw") || n.Contains("overflow") || n == "eca")
        {
            return tower == "Storage";
        }
        if (n == "red" || (n.Contains("red") && n.Contains("tower")))
        {
            return tower == "Red";
        }
        if (n == "green" || (n.Contains("green") && n.Contains("tower")))
        {
            return tower == "Green";
        }
        if (n == "blue" || (n.Contains("blue") && n.Contains("tower")))
        {
            return tower == "Blue";
        }
        if (n == "yellow" || (n.Contains("yellow") && n.Contains("tower")))
        {
            return tower == "Yellow";
        }
        // A route may name the four colored towers "Tower 1".."Tower 4"; play order picks one.
        if (GenericTower.IsMatch(n))
        {
            return GourdReceptacles.IsColoredTower(tower);
        }
        return false;
    }

    /// <summary>Human-readable description for a segment, used in status and logs.</summary>
    public static string Describe(string segmentName)
    {
        string n = Normalize(segmentName);
        if (n.Length == 0)
        {
            return "manual";
        }
        if (n.Contains("tutorial"))
        {
            return "Tutorial";
        }
        if (n.Contains("black") || (n.Contains("final") && n.Contains("tower")))
        {
            return "Black Tower";
        }
        if (n.Contains("storage") || n.Contains("screw") || n.Contains("overflow") || n == "eca")
        {
            return "Storage";
        }
        if (n == "red" || (n.Contains("red") && n.Contains("tower")))
        {
            return "Red Tower";
        }
        if (n == "green" || (n.Contains("green") && n.Contains("tower")))
        {
            return "Green Tower";
        }
        if (n == "blue" || (n.Contains("blue") && n.Contains("tower")))
        {
            return "Blue Tower";
        }
        if (n == "yellow" || (n.Contains("yellow") && n.Contains("tower")))
        {
            return "Yellow Tower";
        }
        return GenericTower.IsMatch(n) ? "any colored tower" : "manual";
    }
}
