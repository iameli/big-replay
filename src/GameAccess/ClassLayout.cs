namespace GameAccess;

/// <summary>
/// A resolved game class: the manifest's field layout plus the runtime static-fields block
/// base (resolved from the binary's types table → Il2CppClass → +0xB8 static_fields).
/// All reads are pure ReadProcessMemory; the static block is re-resolved until non-null
/// (class initializers run lazily).
/// </summary>
public sealed class ClassLayout
{
    // Il2CppType.data.klass at +0x00 (class types); Il2CppClass.static_fields at +0xB8 (x64, modern il2cpp)
    private const int TypeDataKlass = 0x00;
    private const int ClassStaticFields = 0xB8;

    public required string Name { get; init; }
    public required int TypeIndex { get; init; }
    public required bool IsValueType { get; init; }
    public required IReadOnlyDictionary<string, Field> Fields { get; init; }

    public readonly record struct Field(int Offset, bool IsStatic);

    private GameProcess? _game;
    private long _typesTableAddr;
    private long _moduleEnd;

    public long StaticBlock { get; private set; }

    /// <summary>Bind to a process for runtime resolution (types table + static block).</summary>
    public void Bind(GameProcess game, long typesTableAddr, long moduleEnd)
    {
        _game = game;
        _typesTableAddr = typesTableAddr;
        _moduleEnd = moduleEnd;
    }

    /// <summary>Instance field offset (caller adds the object address).</summary>
    public int OffsetOf(string field) => Fields[field].Offset;

    /// <summary>
    /// Try to (re)resolve the static fields block base. Returns true once the block is known.
    /// Must be called each sample until true (class init is lazy).
    /// </summary>
    public bool TryResolveStaticBlock()
    {
        if (StaticBlock != 0)
        {
            return true;
        }
        if (_game is null)
        {
            return false;
        }
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
            // static blocks live in the GC heap (outside the module); any non-null value is the block
            if (staticFields == 0)
            {
                return false;
            }
            StaticBlock = staticFields;
            return true;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    /// <summary>Static field slot address (static block + slot offset); 0 if block unknown.</summary>
    public long StaticSlot(string field)
    {
        if (StaticBlock == 0)
        {
            return 0;
        }
        return StaticBlock + (uint)Fields[field].Offset;
    }

    private bool InModule(long addr) => addr >= _typesTableAddr - 0x10000000 && addr < _moduleEnd;
}

/// <summary>
/// Pure-read attach-time layout: loads the offline manifest, validates the running build,
/// and exposes the per-class layouts the recorder uses. No writes, no threads, no injection.
/// </summary>
public sealed class GameLayout
{
    public required ManifestData Manifest { get; init; }
    public required Dictionary<string, ClassLayout> Classes { get; init; }

    public ClassLayout this[string name] => Classes[name];

    /// <summary>
    /// Load + validate + bind. Throws if the running game build does not match the manifest.
    /// </summary>
    public static GameLayout Attach(GameProcess game, string manifestPath)
    {
        var manifest = ManifestLoader.Load(manifestPath);
        long baseAddr = ManifestLoader.ValidateAgainstProcess(game, manifest);
        long moduleEnd = baseAddr + manifest.ImageSize;
        long typesTable = baseAddr + (long)manifest.TypesTableRva;

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
                TypeIndex = entry.TypeIndex,
                IsValueType = entry.IsValueType,
                Fields = fields,
            };
            layout.Bind(game, typesTable, moduleEnd);
            classes[name] = layout;
        }

        return new GameLayout { Manifest = manifest, Classes = classes };
    }
}