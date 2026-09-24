namespace GameAccess;

/// <summary>
/// A game class: identity + instance field offsets + static slot offsets from the offline manifest;
/// the static-fields block base is resolved purely via the binary's types table → Il2CppClass
/// → static_fields. Pure ReadProcessMemory throughout — nothing is ever written to the game.
///
/// Klass/block offsets (v39, x64): Il2CppType.data at +0x00, Il2CppClass.static_fields at +0xB8.
/// </summary>
public sealed class ClassLayout
{
    private const int TypeDataKlass = 0x00;
    private const int ClassStaticFields = 0xB8;

    public required string Name { get; init; }
    public required string Image { get; init; }
    public required string Namespace { get; init; }
    public required bool IsValueType { get; init; }
    public required IReadOnlyDictionary<string, Field> Fields { get; init; }
    public required IReadOnlyDictionary<string, int> StaticOffsets { get; init; }

    public readonly record struct Field(int Offset, bool IsStatic);

    public IReadOnlyList<string> StaticFieldNames => StaticOffsets.Keys.ToArray();

    private GameProcess? _game;
    private long _typesTableAddr;
    private long _moduleEnd;
    private long _resolvedAt;

    public ulong StaticBlock { get; private set; }
    public bool Resolved { get; private set; }

    /// <summary>Bind to a process for runtime resolution (types table + static block).</summary>
    public void Bind(GameProcess game, long typesTableAddr, long moduleEnd)
    {
        _game = game;
        _typesTableAddr = typesTableAddr;
        _moduleEnd = moduleEnd;
    }

    /// <summary>
    /// Try to (re)resolve the static fields block base; returns false while the class has not
    /// been initialized (re-polled by the sampler). Pure reads only.
    /// </summary>
    public bool TryResolveStaticBlock()
    {
        if (Resolved)
        {
            return true;
        }
        if (_game is null)
        {
            return true;
        }
        if (Environment.TickCount64 - _resolvedAt < 200)
        {
            return false; // throttle to ~5 Hz max
        }
        _resolvedAt = Environment.TickCount64;
        try
        {
            long typePtr = _game.ReadPtr(_typesTableAddr + (long)TypeIndex * 8);
            if (typePtr == 0 || !InModule(typePtr))
            {
                return false;
            }
            long klass = _game.ReadPtr(typePtr + TypeDataKlass);
            if (klass == 0 || !InModule(klass))
            {
                return false;
            }
            long staticFields = _game.ReadPtr(klass + ClassStaticFields);
            // static blocks live in the GC heap (outside the module); non-null = block allocated
            if (staticFields == 0)
            {
                return false;
            }
            StaticBlock = (ulong)staticFields;
            Resolved = true;
            return true;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    /// <summary>Instance field offset (caller adds the object address).</summary>
    public int OffsetOf(string field) => Fields[field].Offset;

    /// <summary>Static field slot address (block base + offline static-slot offset); 0 while unresolved.</summary>
    public long StaticSlot(string field)
    {
        if (StaticBlock == 0)
        {
            return 0;
        }
        return (long)(StaticBlock + (uint)StaticOffsets[field]);
    }

    public int TypeIndex { get; init; }

    private bool InModule(long addr) => addr >= _typesTableAddr - 0x10000000 && addr < _moduleEnd;
}

/// <summary>
/// Pure-read attach-time layout: loads the offline manifest, validates the running build, and
/// binds each class to the process for static-block resolution. No writes, no threads, no injection.
/// </summary>
public sealed class GameLayout
{
    public required ManifestData Manifest { get; init; }
    public required Dictionary<string, ClassLayout> Classes { get; init; }

    public ClassLayout this[string name] => Classes[name];

    public static GameLayout Attach(GameProcess game, string manifestPath)
    {
        var manifest = ManifestLoader.Load(manifestPath);
        long baseAddr = game.GameAssemblyBase;
        ManifestLoader.ValidateAgainstProcess(game, manifest);
        long moduleEnd = baseAddr + manifest.ImageSize;
        long typesTable = baseAddr + (long)manifest.TypesTableRva;

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
            var layout = new ClassLayout
            {
                Name = name,
                Image = entry.Image,
                Namespace = entry.Namespace,
                IsValueType = entry.IsValueType,
                TypeIndex = entry.TypeIndex,
                Fields = fields,
                StaticOffsets = statics,
            };
            layout.Bind(game, typesTable, moduleEnd);
            classes[name] = layout;
        }

        return new GameLayout { Manifest = manifest, Classes = classes };
    }
}