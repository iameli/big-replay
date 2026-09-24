namespace GameAccess;

/// <summary>Per-class manifest entry generated offline (BigWalkReplay.ManifestGen).</summary>
public sealed class ManifestData
{
    public int FormatVersion { get; set; }
    public string GameVersion { get; set; } = "";
    public long BuildId { get; set; }
    public string UnityVersion { get; set; } = "";
    public ulong ImageBase { get; set; }
    public uint ImageSize { get; set; }
    public ulong MetaregRva { get; set; }
    public ulong TypesTableRva { get; set; }
    public ulong FieldOffsetsTableRva { get; set; }
    public ulong TypeDefSizesTableRva { get; set; }
    public uint TypesCount { get; set; }
    public uint FieldOffsetsCount { get; set; }
    public uint TypeDefSizesCount { get; set; }
    public Dictionary<string, ClassEntryData> Classes { get; set; } = new();

    public sealed class ClassEntryData
    {
        public string Image { get; set; } = "";
        public string Namespace { get; set; } = "";
        public int TypeIndex { get; set; }
        public bool IsValueType { get; set; }
        public List<FieldEntryData> Fields { get; set; } = new();
    }

    public sealed class FieldEntryData
    {
        public string Name { get; set; } = "";
        public int Offset { get; set; }
        public bool IsStatic { get; set; }
    }
}

/// <summary>
/// Loads a manifest and matches it against the running game's binary (build fingerprint check).
/// </summary>
public static class ManifestLoader
{
    public static ManifestData Load(string path)
    {
        var json = File.ReadAllText(path);
        var m = System.Text.Json.JsonSerializer.Deserialize<ManifestData>(json,
            new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidOperationException("manifest parse failed");
        if (m.FormatVersion != 1)
        {
            throw new InvalidOperationException($"manifest format version {m.FormatVersion} unsupported");
        }
        return m;
    }

    /// <summary>
    /// Validate the manifest against the loaded module via pure reads. Throws if the build differs.
    /// </summary>
    public static void ValidateAgainstProcess(GameProcess game, ManifestData m)
    {
        long baseAddr = game.GameAssemblyBase;

        // PE header of the loaded module. Windows patches ImageBase in memory to the
        // ASLR-adjusted load address, so it must equal the enumerated module base;
        // SizeOfImage is preserved and must match the manifest.
        byte[] pe = game.ReadBytes(baseAddr + 0x3C, 4);
        int e_lfanew = BitConverter.ToInt32(pe);
        byte[] opt = game.ReadBytes(baseAddr + e_lfanew + 24, 0x48);
        ulong imageBase = BitConverter.ToUInt64(opt, 0x18);
        uint sizeOfImage = BitConverter.ToUInt32(opt, 0x38);
        if (imageBase != (ulong)baseAddr || sizeOfImage != m.ImageSize)
        {
            throw new InvalidOperationException(
                $"game build mismatch: manifest wants size 0x{m.ImageSize:X}, " +
                $"loaded has base 0x{imageBase:X} size 0x{sizeOfImage:X}. Regenerate the manifest for this build.");
        }
    }
}