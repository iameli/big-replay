namespace GameAccess;

/// <summary>
/// A game class: identity + instance field offsets + static slot offsets from the offline manifest;
/// the static-fields block base is resolved via pure-read klass discovery (ClassDiscoveryContext).
/// Nothing is ever written to the game.
/// </summary>
public sealed class ClassLayout
{
    public required string Name { get; init; }
    public required string Image { get; init; }
    public required string Namespace { get; init; }
    public required bool IsValueType { get; init; }
    public required int TypeIndex { get; init; }
    public required IReadOnlyDictionary<string, Field> Fields { get; init; }
    public required IReadOnlyDictionary<string, int> StaticOffsets { get; init; }

    public readonly record struct Field(int Offset, bool IsStatic);

    public IReadOnlyList<string> StaticFieldNames => StaticOffsets.Keys.ToArray();
    public ulong StaticBlock { get; private set; }
    public bool Resolved => StaticBlock != 0;
    public long LastDiscoveryAttempt { get; set; }
    public bool FullScanDone { get; set; }

    public void BindStaticBlock(ulong block) => StaticBlock = block;

    /// <summary>Instance field offset (caller adds the object address).</summary>
    public int OffsetOf(string field) => Fields[field].Offset;

    /// <summary>Static field slot address (block base + offline slot offset); 0 while unresolved.</summary>
    public long StaticSlot(string field)
    {
        if (StaticBlock == 0)
        {
            return 0;
        }
        return (long)(StaticBlock + (uint)StaticOffsets[field]);
    }
}

/// <summary>
/// Pure-read attach-time layout: loads the offline manifest, validates the running build, and
/// wires klass discovery for static resolution. No writes, no threads, no injection.
/// </summary>
public sealed class GameLayout
{
    public required ManifestData Manifest { get; init; }
    public required Dictionary<string, ClassLayout> Classes { get; init; }
    public required ClassDiscoveryContext Discovery { get; init; }

    public ClassLayout this[string name] => Classes[name];

    /// <summary>Throttled pure-read resolution attempt for one class's static block.</summary>
    public bool TryResolveStatics(ClassLayout cls) => Discovery.TryResolve(cls);

    public static GameLayout Attach(GameProcess game, string manifestPath)
    {
        var manifest = ManifestLoader.Load(manifestPath);
        ManifestLoader.ValidateAgainstProcess(game, manifest);

        var classes = new Dictionary<string, ClassLayout>();
        foreach (var (name, entry) in manifest.Classes)
        {
            var fields = entry.Fields.ToDictionary(
                f => f.Name,
                f => new ClassLayout.Field(f.Offset, f.IsStatic),
                StringComparer.Ordinal);
            var statics = entry.Statics.ToDictionary(
                s => s.Name,
                s => s.Offset,
                StringComparer.Ordinal);
            classes[name] = new ClassLayout
            {
                Name = name,
                Image = entry.Image,
                Namespace = entry.Namespace,
                IsValueType = entry.IsValueType,
                TypeIndex = entry.TypeIndex,
                Fields = fields,
                StaticOffsets = statics,
            };
        }

        return new GameLayout
        {
            Manifest = manifest,
            Classes = classes,
            Discovery = new ClassDiscoveryContext(game, manifest),
        };
    }
}