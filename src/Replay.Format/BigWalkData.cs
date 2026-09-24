namespace Replay.Format;

/// <summary>
/// Static game data recovered from the 1.5.1 build (out/src/Assembly-CSharp dump + BigWalk.asl prior art).
/// SaveableHomeName values: monoument0..3 = 100-138, Final 140-148, Intro 150-157, Overflow 160-177.
/// </summary>
public static class BigWalkData
{
    /// <summary>PropHome.pinGroup == this marks a reward-gourd monument home.</summary>
    public const int PropGroupRewardGourd = 19;

    /// <summary>Tower key -> monument slot SaveableHomeName values (same grouping as BigWalk.asl).</summary>
    public static readonly IReadOnlyDictionary<string, int[]> TowerHomes = new Dictionary<string, int[]>
    {
        ["Tutorial"] = [150, 151, 152, 153],
        ["Red"] = [100, 101, 102, 103, 104],
        ["Green"] = [110, 111, 112, 113, 114],
        ["Blue"] = [120, 121, 122, 123, 124],
        ["Yellow"] = [130, 131, 132, 133, 134],
        ["Final"] = [140, 141, 142, 143, 144, 145],
        ["Overflow"] = [160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174],
    };

    public static readonly IReadOnlyDictionary<string, string> TowerNames = new Dictionary<string, string>
    {
        ["Tutorial"] = "Tutorial Tower",
        ["Red"] = "Red Tower",
        ["Green"] = "Green Tower",
        ["Blue"] = "Blue Tower",
        ["Yellow"] = "Yellow Tower",
        ["Final"] = "Final Tower",
        ["Overflow"] = "Overflow",
    };

    /// <summary>All monument slot ids covered by TowerHomes, for landmark collection.</summary>
    public static readonly int[] AllMonumentHomes =
        TowerHomes.Values.SelectMany(v => v).Distinct().OrderBy(v => v).ToArray();
}