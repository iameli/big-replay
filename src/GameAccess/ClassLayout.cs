namespace GameAccess;

/// <summary>
/// A game class: identity + instance field offsets from the offline manifest, statics (block
/// base + per-slot offsets) resolved at attach through il2cpp's own metadata API (one-shot,
/// re-polled until the class initializer runs). Sampling itself is pure ReadProcessMemory.
/// </summary>
public sealed class ClassLayout
{
    public required string Name { get; init; }
    public required string Image { get; init; }
    public required string Namespace { get; init; }
    public required bool IsValueType { get; init; }
    public required IReadOnlyDictionary<string, Field> Fields { get; init; }

    public readonly record struct Field(int Offset, bool IsStatic);

    private readonly Dictionary<string, int> _staticOffsets = new(StringComparer.Ordinal);
    private Il2CppResolver? _resolver;
    private long _resolvedAt;

    public ulong StaticBlock { get; private set; }
    public bool Resolved { get; private set; }

    /// <summary>Attach the one-shot API resolver (called once at attach).</summary>
    public void AttachApi(Il2CppResolver resolver) => _resolver = resolver;

    /// <summary>
    /// Poll the static block + slot offsets (re-polled by the sampler until the class's
    /// initializer has run). Returns false while the block is still null.
    /// </summary>
    public bool TryResolveStatics()
    {
        if (Resolved)
        {
            return true;
        }
        if (_resolver is null)
        {
            return true; // no statics -> trivially resolved
        }
        if (Environment.TickCount64 - _resolvedAt < 500)
        {
            return false; // throttle API calls to 2 Hz max
        }
        _resolvedAt = Environment.TickCount64;

        var statics = Fields.Where(f => f.Value.IsStatic).Select(f => f.Key).ToArray();
        if (statics.Length == 0)
        {
            Resolved = true;
            return true;
        }

        var r = _resolver.Resolve(Image, Namespace, Name, statics);
        if (!r.Ok)
        {
            return false;
        }
        for (int i = 0; i < statics.Length && i < r.Count; i++)
        {
            _staticOffsets[statics[i]] = r.Offsets[i];
        }
        StaticBlock = r.StaticBase;
        Resolved = StaticBlock != 0;
        return Resolved;
    }

    /// <summary>Instance field offset (caller adds the object address).</summary>
    public int OffsetOf(string field) => Fields[field].Offset;

    /// <summary>Static field slot address (block base + slot offset); 0 while unresolved.</summary>
    public long StaticSlot(string field)
    {
        if (StaticBlock == 0)
        {
            return 0;
        }
        int off = _staticOffsets.TryGetValue(field, out int v) ? v : Fields[field].Offset;
        return (long)StaticBlock + (uint)off;
    }
}

/// <summary>
/// Attach-time layout: loads the offline manifest, validates the running build, and wires the
/// one-shot il2cpp metadata resolver for static resolution. Sampling stays pure reads.
/// </summary>
public sealed class GameLayout
{
    public required ManifestData Manifest { get; init; }
    public required Dictionary<string, ClassLayout> Classes { get; init; }

    public ClassLayout this[string name] => Classes[name];

    public static GameLayout Attach(GameProcess game, string manifestPath)
    {
        var manifest = ManifestLoader.Load(manifestPath);
        ManifestLoader.ValidateAgainstProcess(game, manifest);
        var resolver = new Il2CppResolver(game);

        var classes = new Dictionary<string, ClassLayout>();
        foreach (var (name, entry) in manifest.Classes)
        {
            var fields = entry.Fields.ToDictionary(
                f => f.Name,
                f => new ClassLayout.Field(f.Offset, f.IsStatic),
                StringComparer.Ordinal);
            var layout = new ClassLayout
            {
                Name = name,
                Image = entry.Image,
                Namespace = entry.Namespace,
                IsValueType = entry.IsValueType,
                Fields = fields,
            };
            if (fields.Any(f => f.Value.IsStatic))
            {
                layout.AttachApi(resolver);
            }
            classes[name] = layout;
        }

        return new GameLayout { Manifest = manifest, Classes = classes };
    }
}