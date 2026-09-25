using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace GameAccess;

/// <summary>
/// Handle to the running game. Steady-state recording is pure ReadProcessMemory;
/// write-capable access rights are granted only for the one-shot attach-time metadata
/// resolver (VirtualAllocEx/CreateRemoteThread), which never mutates game state.
/// </summary>
public sealed unsafe class GameProcess : IDisposable
{
    public const string ProcessName = "Big Walk";

    private const uint ProcessVmRead = 0x0010;
    private const uint ProcessVmWrite = 0x0020;
    private const uint ProcessVmOperation = 0x0008;
    private const uint ProcessCreateThread = 0x0002;
    private const uint ProcessQueryInformation = 0x0400;
    private const uint ProcessQueryLimitedInformation = 0x1000;

    private readonly nint _handle;

    public nint Handle => _handle;
    public long GameAssemblyBase { get; }
    public long GameAssemblySize { get; }

    public bool HasExited
    {
        get
        {
            if (!GetExitCodeProcess(_handle, out uint code))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to query the game process.");
            }
            return code != 259; // STILL_ACTIVE
        }
    }

    private GameProcess(nint handle, long gaBase, long gaSize)
    {
        _handle = handle;
        GameAssemblyBase = gaBase;
        GameAssemblySize = gaSize;
    }

    /// <summary>Attach to the first running Big Walk process. Throws if none is running.</summary>
    public static GameProcess Attach(string processName = ProcessName)
    {
        ArgumentNullException.ThrowIfNull(processName);
        string exeBase = Path.GetFileNameWithoutExtension(processName);
        Process[] processes = Process.GetProcessesByName(exeBase);
        using Process? proc = processes.FirstOrDefault();
        for (int i = 1; i < processes.Length; i++)
        {
            processes[i].Dispose();
        }
        if (proc is null)
        {
            throw new InvalidOperationException($"No {processName} process found. Is the game running?");
        }

        uint fullAccess = ProcessVmRead | ProcessQueryInformation;
        nint handle = OpenProcess(fullAccess, false, (uint)proc.Id);
        int fullErr = Marshal.GetLastWin32Error();
        if (handle == 0)
        {
            Console.Error.WriteLine($"WARN: OpenProcess(full access 0x{fullAccess:X}) failed ({fullErr}); falling back to read-only handle");
            handle = OpenProcess(ProcessVmRead | ProcessQueryLimitedInformation, false, (uint)proc.Id);
        }
        if (handle == 0)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), $"OpenProcess failed for PID {proc.Id}");
        }

        try
        {
            long gaBase = 0, gaSize = 0;
            var modules = new nint[1024];
            uint needed = 0;
            EnumProcessModulesEx(handle, modules, (uint)(modules.Length * nint.Size), ref needed, 0x03);
            int count = Math.Min(modules.Length, (int)(needed / (uint)nint.Size));
            for (int i = 0; i < count; i++)
            {
                var name = new byte[260];
                if (GetModuleBaseNameA(handle, modules[i], name, (uint)name.Length) == 0)
                {
                    continue;
                }
                string modName = System.Text.Encoding.ASCII.GetString(name).TrimEnd('\0');
                if (!string.Equals(modName, "GameAssembly.dll", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                var info = new ModuleInfo();
                GetModuleInformation(handle, modules[i], ref info, (uint)Marshal.SizeOf<ModuleInfo>());
                gaBase = (long)info.BaseOfDll;
                gaSize = info.SizeOfImage;
                break;
            }

            if (gaBase == 0)
            {
                throw new InvalidOperationException("GameAssembly.dll not found in process module list.");
            }
            return new GameProcess(handle, gaBase, gaSize);
        }
        catch
        {
            CloseHandle(handle);
            throw;
        }
    }

    public bool TryReadBytes(long address, Span<byte> destination)
    {
        if (address < 0 || destination.IsEmpty)
        {
            return false;
        }
        nint bytesRead = 0;
        fixed (byte* p = destination)
        {
            bool ok = ReadProcessMemory(_handle, (nint)address, p, (nuint)destination.Length, ref bytesRead);
            return ok && bytesRead == destination.Length;
        }
    }

    public byte[] ReadBytes(long address, int length)
    {
        var buf = new byte[length];
        if (!TryReadBytes(address, buf))
        {
            throw new InvalidOperationException($"ReadProcessMemory failed at 0x{address:X} len {length}.");
        }
        return buf;
    }

    public T Read<T>(long address) where T : unmanaged
    {
        int size = Unsafe.SizeOf<T>();
        Span<byte> raw = stackalloc byte[size];
        if (!TryReadBytes(address, raw))
        {
            return default;
        }
        return MemoryMarshal.Read<T>(raw);
    }

    public long ReadPtr(long address) => Read<long>(address);
    public int ReadInt32(long address) => Read<int>(address);
    public float ReadSingle(long address) => Read<float>(address);
    public bool ReadBool(long address) => Read<byte>(address) != 0;

    /// <summary>Read an ASCII string (up to maxLen) at an address.</summary>
    public string ReadAscii(long address, int maxLen = 256)
    {
        Span<byte> raw = stackalloc byte[Math.Min(maxLen, 4096)];
        if (!TryReadBytes(address, raw))
        {
            return string.Empty;
        }
        int end = raw.IndexOf((byte)0);
        if (end < 0)
        {
            end = raw.Length;
        }
        return System.Text.Encoding.ASCII.GetString(raw[..end]);
    }

    public void Dispose() => CloseHandle(_handle);

    // --- P/Invoke ---
    private struct ModuleInfo
    {
        public nint BaseOfDll;
        public uint SizeOfImage;
        public nint EntryPoint;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(nint process, nint address, byte* buffer, nuint size, ref nint bytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(nint handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(nint process, out uint exitCode);

    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool EnumProcessModulesEx(nint process, nint[] modules, uint size, ref uint needed, uint filter);

    [DllImport("psapi.dll", SetLastError = true)]
    private static extern uint GetModuleBaseNameA(nint process, nint module, byte[] name, uint size);

    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool GetModuleInformation(nint process, nint module, ref ModuleInfo info, uint size);
}