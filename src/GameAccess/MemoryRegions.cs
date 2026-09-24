using System.Runtime.InteropServices;

namespace GameAccess;

/// <summary>Committed + readable memory region enumeration (VirtualQueryEx). Pure reads.</summary>
public static class MemoryRegions
{
    public readonly record struct Region(long Start, long Size);

    private static nint _handle;
    public static void Init(nint processHandle) => _handle = processHandle;

    public static IEnumerable<Region> Readable(long lo, long hi)
    {
        long addr = lo & ~0xFFFFL;
        while (addr < hi)
        {
            var mbi = new MemoryBasicInformation();
            if (VirtualQueryEx(_handle, (nint)addr, ref mbi, (nuint)Marshal.SizeOf<MemoryBasicInformation>()) == 0)
            {
                break;
            }
            long start = (long)mbi.BaseAddress;
            long size = (long)mbi.RegionSize;
            if (size <= 0)
            {
                break;
            }
            bool readable = mbi.State == 0x1000 /* MEM_COMMIT */
                && mbi.Protect is 0x04 or 0x02 or 0x40 or 0x80 or 0x20 or 0x10;
            if (readable)
            {
                long rStart = Math.Max(start, lo);
                long rEnd = Math.Min(start + size, hi);
                if (rEnd > rStart)
                {
                    yield return new Region(rStart, rEnd - rStart);
                }
            }
            addr = (start + size + 0xFFFF) & ~0xFFFFL;
            if (addr >= 0x7FFFFFFFF000)
            {
                break;
            }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryBasicInformation
    {
        public nint BaseAddress;
        public nint AllocationBase;
        public uint AllocationProtect;
        public uint PartitionId;
        public long RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nuint VirtualQueryEx(nint process, nint address, ref MemoryBasicInformation info, nuint length);
}