namespace GameAccess;

/// <summary>
/// Pure-read class discovery for modern il2cpp: klass objects are heap-allocated and registered
/// lazily. Reliable pure-read route: (1) locate the class's name string in the metadata image
/// (near the type handle), (2) scan memory for qwords pointing at it, (3) validate the candidate
/// as a klass (self pointer at +0x78, non-null static-fields block at +0xB8).
/// Windowed scanning around the first resolved klass; each class gets ONE full-space widen
/// (recording never hinges on classes that are simply never created in the session).
/// </summary>
public sealed class ClassDiscoveryContext
{
    private const int KlassNameOffset = 0x10;
    private const int KlassSelfOffset = 0x78;
    private const int KlassStaticFields = 0xB8;
    private const int Chunk = 0x10_0000;

    private readonly GameProcess _game;
    private readonly long _typesTable;
    private long? _windowCenter;

    public ClassDiscoveryContext(GameProcess game, ManifestData manifest)
    {
        _game = game;
        _typesTable = game.GameAssemblyBase + (long)manifest.TypesTableRva;
        MemoryRegions.Init(game.Handle);
    }

    /// <summary>Resolve the static block of one class. Pure reads; throttled.</summary>
    public bool TryResolve(ClassLayout cls)
    {
        if (cls.Resolved)
        {
            return true;
        }
        if (Environment.TickCount64 - cls.LastDiscoveryAttempt < 1000)
        {
            return false;
        }
        cls.LastDiscoveryAttempt = Environment.TickCount64;
        try
        {
            long typePtr = _game.ReadPtr(_typesTable + (long)cls.TypeIndex * 8);
            long handle = _game.ReadPtr(typePtr); // typeHandle into the metadata image
            var strings = FindStringsNear(handle, cls.Name);
            if (strings.Count == 0)
            {
                return false;
            }

            long? klass;
            if (_windowCenter.HasValue)
            {
                long lo = _windowCenter.Value - 0x40_00_00;
                long hi = _windowCenter.Value + 0x40_00_00;
                klass = ScanRefs(lo, hi, strings);
                if (klass == null && !cls.FullScanDone)
                {
                    cls.FullScanDone = true;
                    klass = ScanRefs(0x1000, 0x7FFFFFFFFFFF, strings); // one full widen per class
                    if (klass != null)
                    {
                        _windowCenter = klass;
                    }
                }
            }
            else
            {
                // first class: module region first (fast), then one full pass
                long modBase = _game.GameAssemblyBase;
                klass = ScanRefs(modBase, modBase + _game.GameAssemblySize, strings);
                if (klass == null)
                {
                    cls.FullScanDone = true;
                    klass = ScanRefs(0x1000, 0x7FFFFFFFFFFF, strings);
                }
                if (klass != null)
                {
                    _windowCenter = klass;
                }
            }
            if (klass == null)
            {
                return false;
            }

            long block = _game.ReadPtr(klass.Value + KlassStaticFields);
            if (block == 0)
            {
                return false; // class initializer has not run yet; retry on a later sample
            }
            cls.BindStaticBlock((ulong)block);
            return true;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    private List<long> FindStringsNear(long handle, string className)
    {
        var needle = System.Text.Encoding.ASCII.GetBytes(className + "\0");
        var hits = new List<long>();
        var chunk = new byte[Chunk];
        const long range = 0x200_0000; // ±32 MB: the metadata image
        for (long d = -range; d < range; d += Chunk)
        {
            long baseAddr = handle + d;
            if (baseAddr < 0x1000)
            {
                continue;
            }
            if (!_game.TryReadBytes(baseAddr, chunk))
            {
                continue;
            }
            int p = chunk.AsSpan().IndexOf(needle);
            while (p >= 0)
            {
                hits.Add(baseAddr + p);
                if (hits.Count >= 3)
                {
                    return hits.GetRange(0, 3); // a few copies suffice; keeps the ref scan fast
                }
                p = chunk.AsSpan(p + 1).IndexOf(needle);
            }
        }
        return hits;
    }

    private long? ScanRefs(long lo, long hi, List<long> strings)
    {
        byte[][] needles = strings.Select(s => BitConverter.GetBytes(s)).ToArray();
        foreach (var region in MemoryRegions.Readable(lo, hi))
        {
            long addr = region.Start;
            long end = region.Start + region.Size;
            var buf = new byte[Math.Min(Chunk, region.Size)];
            while (addr < end)
            {
                int want = (int)Math.Min(Chunk, end - addr);
                if (want != buf.Length)
                {
                    buf = new byte[want];
                }
                if (!_game.TryReadBytes(addr, buf))
                {
                    break;
                }
                foreach (var needle in needles)
                {
                    int off = 0;
                    while (off <= buf.Length - 8)
                    {
                        int p = buf.AsSpan(off).IndexOf(needle);
                        if (p < 0)
                        {
                            break;
                        }
                        long refAddr = addr + off + p;
                        long cand = refAddr - KlassNameOffset;
                        long self = _game.ReadPtr(cand + KlassSelfOffset);
                        if (self == cand)
                        {
                            long block = _game.ReadPtr(cand + KlassStaticFields);
                            if (block != 0)
                            {
                                return cand;
                            }
                        }
                        off += p + 1;
                    }
                }
                addr += Chunk;
            }
        }
        return null;
    }
}