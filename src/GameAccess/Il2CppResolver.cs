using System.Runtime.InteropServices;

namespace GameAccess;

public sealed class Il2CppResolver
{
    public const int MaxFields = 8;

    public sealed record Result(ulong StaticBase, int[] Offsets, int Count, int Error)
    {
        public bool Ok => Error == 0;
    }

    private readonly GameProcess _game;

    public Il2CppResolver(GameProcess game) => _game = game;

    /// <summary>
    /// Resolve a class's static-field block base and the offsets of the named fields by running a tiny
    /// code blob inside the game that calls il2cpp's own metadata API (class_from_name / field_get_offset /
    /// class_get_static_fields). One-shot per attach (re-polled while a class initializer has not run);
    /// the blob queries metadata only and mutates nothing.
    /// </summary>
    public Result Resolve(string image, string ns, string cls, params string[] fields)
    {
        if (fields.Length > MaxFields)
        {
            throw new ArgumentOutOfRangeException(nameof(fields), $"at most {MaxFields} fields");
        }

        var attempts = new[] { image, image + ".dll" };
        Exception? last = null;
        foreach (string img in attempts)
        {
            try
            {
                return ResolveOnce(img, ns, cls, fields);
            }
            catch (Exception e)
            {
                last = e;
            }
        }
        throw new InvalidOperationException($"Resolver failed for {image}.{cls}", last);
    }



    private unsafe Result ResolveOnce(string image, string ns, string cls, string[] fields)
    {
        const int page = 0x1000;
        const int codeOff = 0x0000;
        const int outOff = 0x0800;  // staticBase(8) + offsets[8*4] + count(4) + err(4)
        const int inOff = 0x0900;   // image, ns, class, field names[], out ptr
        const int strOff = 0x0A00;

        nint alloc = VirtualAllocEx(_game.Handle, IntPtr.Zero, (nuint)page,
            MemCommit | MemReserve, PageExecuteReadWrite);
        if (alloc == 0)
        {
            throw new InvalidOperationException($"VirtualAllocEx failed: {Marshal.GetLastWin32Error()}");
        }
        long baseAddr = alloc.ToInt64();

        try
        {
            var str = new List<byte>();
            var strAddrs = new Dictionary<string, long>();
            long Place(string s)
            {
                if (strAddrs.TryGetValue(s, out long a))
                {
                    return a;
                }
                byte[] b = System.Text.Encoding.ASCII.GetBytes(s);
                int off = str.Count;
                str.AddRange(b);
                str.Add(0);
                long addr = baseAddr + strOff + off;
                strAddrs[s] = addr;
                return addr;
            }

            long aImage = Place(image);
            long aNs = Place(ns);
            long aClass = Place(cls);
            long[] aFields = new long[fields.Length];
            for (int i = 0; i < fields.Length; i++)
            {
                aFields[i] = Place(fields[i]);
            }
            long aGameAssembly = Place("GameAssembly.dll");
            string[] apiNames =
            [
                "il2cpp_domain_get_assemblies",
                "il2cpp_assembly_get_image",
                "il2cpp_image_get_name",
                "il2cpp_class_from_name",
                "il2cpp_class_get_static_fields",
                "il2cpp_class_get_fields",
                "il2cpp_field_get_name",
                "il2cpp_field_get_offset",
            ];
            long[] aApiNames = new long[apiNames.Length];
            for (int i = 0; i < apiNames.Length; i++)
            {
                aApiNames[i] = Place(apiNames[i]);
            }

            var b = new BlobBuilder();
            (byte[] blob, BlobData data) = BuildBlob(b);

            byte[] input = new byte[0x60];
            var inMs = new MemoryStream(input);
            WriteLong(inMs, aImage);
            WriteLong(inMs, aNs);
            WriteLong(inMs, aClass);
            for (int i = 0; i < fields.Length; i++)
            {
                WriteLong(inMs, aFields[i]);
            }
            for (int i = fields.Length; i < MaxFields; i++)
            {
                WriteLong(inMs, 0);
            }
            WriteLong(inMs, baseAddr + outOff);

            WriteBytes(baseAddr + codeOff, blob);
            WriteBytes(baseAddr + inOff, input);
            WriteBytes(baseAddr + strOff, str.ToArray());

            long dataBase = baseAddr + data.Offset;
            WriteInt64(dataBase + data.StrGameAssembly, aGameAssembly);
            WriteInt64(dataBase + data.K32GetModuleHandle, Kernel.GetModuleHandleAddress("kernel32.dll"));
            WriteInt64(dataBase + data.K32GetProcAddress, Kernel.GetProcAddressAddress("kernel32.dll", "GetProcAddress"));
            for (int i = 0; i < apiNames.Length; i++)
            {
                WriteInt64(dataBase + data.ResolveTable + i * 16, aApiNames[i]);
                WriteInt64(dataBase + data.ResolveTable + i * 16 + 8, dataBase + data.ApiSlots[i]);
            }
            WriteInt64(dataBase + data.ResolveTablePtr, dataBase + data.ResolveTable);

            uint threadId = 0;
            nint thread = CreateRemoteThread(_game.Handle, IntPtr.Zero, 0,
                (nint)baseAddr, (nint)(baseAddr + inOff), 0, ref threadId);
            if (thread == 0)
            {
                throw new InvalidOperationException($"CreateRemoteThread failed: {Marshal.GetLastWin32Error()}");
            }
            try
            {
                WaitForSingleObject(thread, 10_000);
                Span<byte> outRaw = stackalloc byte[0x30];
                if (!_game.TryReadBytes(baseAddr + outOff, outRaw))
                {
                    throw new InvalidOperationException("Failed to read resolver output.");
                }
                ulong staticBase = MemoryMarshal.Read<ulong>(outRaw[0..8]);
                var offsets = new int[MaxFields];
                for (int i = 0; i < MaxFields; i++)
                {
                    offsets[i] = MemoryMarshal.Read<int>(outRaw[(8 + i * 4)..]);
                }
                int count = MemoryMarshal.Read<int>(outRaw[0x28..]);
                int err = MemoryMarshal.Read<int>(outRaw[0x2C..]);
                return new Result(staticBase, offsets, count, err == 0 ? 0 : err);
            }
            finally
            {
                CloseHandle(thread);
            }
        }
        finally
        {
            VirtualFreeEx(_game.Handle, alloc, 0, MemRelease);
        }
    }

    private static void WriteLong(Stream s, long value)
    {
        Span<byte> raw = stackalloc byte[8];
        MemoryMarshal.Write(raw, value);
        s.Write(raw);
    }

    private void WriteBytes(long addr, byte[] data)
    {
        var span = new Span<byte>(data);
        unsafe
        {
            fixed (byte* p = span)
            {
                nint written = 0;
                if (!WriteProcessMemory(_game.Handle, (nint)addr, p, (nuint)data.Length, ref written)
                    || written != data.Length)
                {
                    throw new InvalidOperationException($"WriteProcessMemory failed at 0x{addr:X}.");
                }
            }
        }
    }

    private void WriteInt64(long addr, long value) => WriteBytes(addr, BitConverter.GetBytes(value));

    private static class Locals
    {
        // disp8 two's-complement offsets for [rbp+disp8]; saved regs occupy rbp-0x08..-0x20
        public const byte Image = 0xD8;    // -0x28
        public const byte Iter = 0xD0;     // -0x30
        public const byte Count = 0xC8;    // -0x38
        public const byte Index = 0xC0;    // -0x40
        public const byte NameIdx = 0xB8;  // -0x48
        public const byte NamePtr = 0xB0;  // -0x50
        public const byte HModule = 0xA8;  // -0x58
    }

    internal sealed class BlobData
    {
        public int Offset;
        public int[] ApiSlots = new int[8];
        public int K32GetModuleHandle;
        public int K32GetProcAddress;
        public int StrGameAssembly;
        public int ResolveTablePtr;
        public int ResolveTable;
        public int CodeSize;
    }

    private static (byte[] Blob, BlobData Data) BuildBlob(BlobBuilder b)
    {
        b.Emit(0x55);                                            // push rbp
        b.Emit(0x48, 0x89, 0xE5);                                // mov rbp,rsp
        b.Emit(0x53);                                            // push rbx
        b.Emit(0x41, 0x54);                                      // push r12
        b.Emit(0x41, 0x55);                                      // push r13
        b.Emit(0x41, 0x56);                                      // push r14
        b.Emit(0x48, 0x83, 0xEC, 0x60);                          // sub rsp,0x60

        b.Emit(0x49, 0x89, 0xCE);                                // mov r14,rcx (IN)
        b.Emit(0x4D, 0x8B, 0x66, 0x58);                          // mov r12,[r14+0x58] (OUT)
        b.RipMov("rbx", "d_restable_ptr");
        b.RipMov("rcx", "d_str_ga");
        b.RipMov("rax", "d_k32_gmh");
        b.Emit(0xFF, 0xD0);                                      // call GetModuleHandleA
        b.Emit(0x48, 0x85, 0xC0);
        b.Jz("err4");
        b.Emit(0x48, 0x89, 0x45, (byte)Locals.HModule);          // mov [rbp+loc],rax
        b.Label("rs_loop");
        b.Emit(0x48, 0x8B, 0x0B);                                // mov rcx,[rbx]
        b.Emit(0x48, 0x85, 0xC9);
        b.Jz("rs_done");
        b.Emit(0x48, 0x89, 0xCA);                                // mov rdx,rcx (name)
        b.Emit(0x48, 0x8B, 0x4D, (byte)Locals.HModule);
        b.RipMov("rax", "d_k32_gpa");
        b.Emit(0xFF, 0xD0);                                      // call GetProcAddress
        b.Emit(0x48, 0x8B, 0x4B, 0x08);                          // mov rcx,[rbx+8] (slot ptr)
        b.Emit(0x48, 0x89, 0x01);                                // mov [rcx],rax
        b.Emit(0x48, 0x83, 0xC3, 0x10);                          // add rbx,0x10
        b.Jmp("rs_loop");
        b.Label("rs_done");
        // verify all 8 api slots resolved
        b.RipLeaRbx("d0");
        b.Emit(0x48, 0xC7, 0xC1, 8, 0, 0, 0);                    // mov rcx,8
        b.Label("v_loop");
        b.Emit(0x48, 0x8B, 0x03);                                // mov rax,[rbx]
        b.Emit(0x48, 0x85, 0xC0);
        b.Jz("err6");
        b.Emit(0x48, 0x83, 0xC3, 8);                             // add rbx,8
        b.Emit(0x48, 0xFF, 0xC9);                                // dec rcx
        b.Jnz("v_loop");
        b.RipMov("rax", "s0");
        b.Emit(0x48, 0x85, 0xC0);
        b.Jz("err5");

        // assemblies: il2cpp_domain_get_assemblies(&count)
        b.Emit(0x48, 0x8D, 0x55, (byte)Locals.Count);            // lea rdx,[rbp+loc]
        b.RipMov("rax", "s0");
        b.Emit(0xFF, 0xD0);
        b.Emit(0x48, 0x85, 0xC0);
        b.Jz("err1");
        b.Emit(0x49, 0x89, 0xC5);                                // mov r13,rax (assemblies)
        b.Emit(0x8B, 0x5D, (byte)Locals.Count);                  // mov ebx,[rbp+loc]
        b.Emit(0x48, 0xC7, 0x45, (byte)Locals.Index, 0, 0, 0, 0);

        b.Label("img_loop");
        b.Emit(0x48, 0x83, 0x7D, (byte)Locals.Count, 0);
        b.Jz("err2");
        b.Emit(0x48, 0x8B, 0x45, (byte)Locals.Index);            // mov rax,[rbp+loc] (index)
        b.Emit(0x49, 0x8B, 0x4C, 0xC5, 0x00);                    // mov rcx,[r13+rax*8]
        b.RipMov("rax", "s1");
        b.Emit(0xFF, 0xD0);                                      // call il2cpp_assembly_get_image
        b.Emit(0x48, 0x89, 0x45, (byte)Locals.Image);            // mov [rbp+loc],rax (image)
        b.Emit(0x48, 0x89, 0xC1);
        b.RipMov("rax", "s2");
        b.Emit(0xFF, 0xD0);                                      // call il2cpp_image_get_name
        b.Emit(0x48, 0x89, 0xC3);                                // mov rbx,rax (name)
        b.Emit(0x49, 0x8B, 0x16);                                // mov rdx,[r14] (expected)
        b.Call("strcmp");
        b.Emit(0x85, 0xC0);
        b.Jz("img_found");
        b.Emit(0x48, 0xFF, 0x45, (byte)Locals.Index);
        b.Emit(0x48, 0xFF, 0x4D, (byte)Locals.Count);
        b.Jmp("img_loop");

        b.Label("img_found");
        b.Emit(0x48, 0x8B, 0x4D, (byte)Locals.Image);            // mov rcx,[rbp+loc] (image)
        b.Emit(0x49, 0x8B, 0x56, 0x08);                          // mov rdx,[r14+8] (ns)
        b.Emit(0x4D, 0x8B, 0x46, 0x10);                          // mov r8,[r14+0x10] (class)
        b.RipMov("rax", "s3");
        b.Emit(0xFF, 0xD0);                                      // call il2cpp_class_from_name
        b.Emit(0x48, 0x85, 0xC0);
        b.Jz("err3");
        b.Emit(0x49, 0x89, 0xC5);                                // mov r13,rax (klass)
        b.Emit(0x48, 0x89, 0xC1);
        b.RipMov("rax", "s4");
        b.Emit(0xFF, 0xD0);                                      // call il2cpp_class_get_static_fields
        b.Emit(0x49, 0x89, 0x04, 0x24);                          // mov [r12],rax (OUT.staticBase)
        // iterate fields
        b.Emit(0x31, 0xD2);                                      // xor edx,edx
        b.Emit(0x4C, 0x8D, 0x45, (byte)Locals.Iter);             // lea r8,[rbp+loc] (&iter)

        b.Label("field_loop");
        b.Emit(0x4C, 0x89, 0xE9);                                // mov rcx,r13 (klass)
        b.Emit(0x4C, 0x8D, 0x45, (byte)Locals.Iter);
        b.RipMov("rax", "s5");
        b.Emit(0xFF, 0xD0);                                      // call il2cpp_class_get_fields
        b.Emit(0x48, 0x85, 0xC0);
        b.Jz("done_ok");
        b.Emit(0x48, 0x89, 0xC3);                                // mov rbx,rax (field)
        b.Emit(0x48, 0x89, 0xC1);
        b.RipMov("rax", "s6");
        b.Emit(0xFF, 0xD0);                                      // call il2cpp_field_get_name
        b.Emit(0x48, 0x89, 0x45, (byte)Locals.NamePtr);          // mov [rbp+loc],rax (name)
        b.Emit(0x48, 0xC7, 0x45, (byte)Locals.NameIdx, 0, 0, 0, 0);

        b.Label("name_loop");
        b.Emit(0x48, 0x83, 0x7D, (byte)Locals.NameIdx, 8);       // cmp qword [rbp+loc],8
        b.Jae("field_loop");
        b.Emit(0x4C, 0x89, 0xF1);                                // mov rcx,r14 (IN)
        b.Emit(0x48, 0x8B, 0x55, (byte)Locals.NameIdx);
        b.Emit(0x48, 0x8B, 0x54, 0xD1, 0x18);                    // mov rdx,[rcx+rdx*8+0x18]
        b.Emit(0x48, 0x85, 0xD2);
        b.Jz("name_next");
        b.Emit(0x48, 0x8B, 0x4D, (byte)Locals.NamePtr);
        b.Call("strcmp");
        b.Emit(0x85, 0xC0);
        b.Jnz("name_next");
        // match -> record offset
        b.Emit(0x48, 0x89, 0xCB);                                // mov rcx,rbx (field)
        b.RipMov("rax", "s7");
        b.Emit(0xFF, 0xD0);                                      // call il2cpp_field_get_offset
        b.Emit(0x41, 0x8B, 0x4C, 0x24, 0x28);                    // mov ecx,[r12+0x28] (count)
        b.Emit(0x41, 0x89, 0x44, 0x8C, 0x08);                    // mov [r12+rcx*4+8],eax
        b.Emit(0x41, 0xFF, 0x44, 0x24, 0x28);                    // inc dword [r12+0x28]
        b.Jmp("field_loop");
        b.Label("name_next");
        b.Emit(0x48, 0xFF, 0x45, (byte)Locals.NameIdx);
        b.Jmp("name_loop");

        b.Label("done_ok");
        b.Emit(0x31, 0xC0);
        b.Jmp("fin");
        b.Label("err1");
        b.Emit(0xB8, 1, 0, 0, 0); b.Jmp("fin");
        b.Label("err2");
        b.Emit(0xB8, 2, 0, 0, 0); b.Jmp("fin");
        b.Label("err3");
        b.Emit(0xB8, 3, 0, 0, 0); b.Jmp("fin");
        b.Label("err4");
        b.Emit(0xB8, 4, 0, 0, 0); b.Jmp("fin");
        b.Label("err5");
        b.Emit(0xB8, 5, 0, 0, 0); b.Jmp("fin");
        b.Label("err6");
        b.Emit(0xB8, 6, 0, 0, 0); b.Jmp("fin");
        b.Label("fin");
        b.Emit(0x41, 0x89, 0x44, 0x24, 0x2C);                    // mov [r12+0x2C],eax (err)
        b.Emit(0x48, 0x83, 0xC4, 0x60);
        b.Emit(0x41, 0x5E);                                      // pop r14
        b.Emit(0x41, 0x5D);                                      // pop r13
        b.Emit(0x41, 0x5C);                                      // pop r12
        b.Emit(0x5B);                                            // pop rbx
        b.Emit(0x5D);                                            // pop rbp
        b.Emit(0xC3);                                            // ret

        // strcmp(rcx=a, rdx=b) -> eax==0 if equal
        b.Label("strcmp");
        b.Emit(0x49, 0x89, 0xC8);                                // mov r8,rcx
        b.Emit(0x49, 0x89, 0xD1);                                // mov r9,rdx
        b.Label("slp");
        b.Emit(0x41, 0x8A, 0x00);                                // mov al,[r8]
        b.Emit(0x41, 0x8A, 0x11);                                // mov dl,[r9]
        b.Emit(0x38, 0xD0);                                      // cmp al,dl
        b.Jnz("sne");
        b.Emit(0x84, 0xC0);                                      // test al,al
        b.Jz("seq");
        b.Emit(0x49, 0xFF, 0xC0);                                // inc r8
        b.Emit(0x49, 0xFF, 0xC1);                                // inc r9
        b.Jmp("slp");
        b.Label("seq");
        b.Emit(0x31, 0xC0);
        b.Emit(0xC3);
        b.Label("sne");
        b.Emit(0xB8, 1, 0, 0, 0);
        b.Emit(0xC3);

        // ---- data section (slots patched post-allocation) ----
        b.Label("d0"); b.Label("s0"); b.Reserve8();
        b.Label("d1"); b.Label("s1"); b.Reserve8();
        b.Label("d2"); b.Label("s2"); b.Reserve8();
        b.Label("d3"); b.Label("s3"); b.Reserve8();
        b.Label("d4"); b.Label("s4"); b.Reserve8();
        b.Label("d5"); b.Label("s5"); b.Reserve8();
        b.Label("d6"); b.Label("s6"); b.Reserve8();
        b.Label("d7"); b.Label("s7"); b.Reserve8();
        b.Label("d_k32_gmh"); b.Reserve8();
        b.Label("d_k32_gpa"); b.Reserve8();
        b.Label("d_str_ga"); b.Reserve8();
        b.Label("d_restable_ptr"); b.Reserve8();
        b.Label("d_restable"); b.ReserveBytes(8 * 16);

        byte[] blob = b.Build(out var data);
        return (blob, data);
    }

    // ---- native imports ----
    private const uint MemCommit = 0x1000;
    private const uint MemReserve = 0x2000;
    private const uint MemRelease = 0x8000;
    private const uint PageExecuteReadWrite = 0x40;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint VirtualAllocEx(nint process, nint address, nuint size, uint allocType, uint protect);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool VirtualFreeEx(nint process, nint address, nuint size, uint freeType);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint CreateRemoteThread(nint process, nint attrs, nuint stackSize, nint start, nint param, uint flags, ref uint threadId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(nint handle, uint ms);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(nint handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint GetModuleHandleA(string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint GetProcAddress(nint module, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern unsafe bool WriteProcessMemory(nint process, nint address, byte* buffer, nuint size, ref nint bytesWritten);

    private static class Kernel
    {
        public static long GetModuleHandleAddress(string name)
        {
            nint m = GetModuleHandleA(name);
            return m == 0 ? throw new InvalidOperationException($"GetModuleHandle({name}) failed") : m.ToInt64();
        }

        public static long GetProcAddressAddress(string module, string proc)
        {
            nint m = GetModuleHandleA(module);
            if (m == 0)
            {
                throw new InvalidOperationException($"GetModuleHandle({module}) failed");
            }
            nint p = GetProcAddress(m, proc);
            return p == 0 ? throw new InvalidOperationException($"GetProcAddress({proc}) failed") : p.ToInt64();
        }
    }
}

/// <summary>Minimal x64 emitter for the resolver blob. Hand-encoded, position-independent.</summary>
internal sealed class BlobBuilder
{
    private readonly List<byte> _code = new();
    private readonly Dictionary<string, int> _labels = new();
    private readonly List<(int Site, string Target)> _rel32 = new();
    private readonly List<(int Site, string Target)> _riprel = new();

    public int Total => _code.Count;

    public void Emit(params byte[] bytes) => _code.AddRange(bytes);
    public void Reserve8() => _code.AddRange(new byte[8]);
    public void ReserveBytes(int n) => _code.AddRange(new byte[n]);

    public void Label(string name) => _labels[name] = _code.Count;

    public void Jz(string target) { _code.Add(0x0F); _code.Add(0x84); _rel32.Add((_code.Count, target)); _code.Add(0); _code.Add(0); _code.Add(0); _code.Add(0); }
    public void Jnz(string target) { _code.Add(0x0F); _code.Add(0x85); _rel32.Add((_code.Count, target)); _code.Add(0); _code.Add(0); _code.Add(0); _code.Add(0); }
    public void Jae(string target) { _code.Add(0x0F); _code.Add(0x83); _rel32.Add((_code.Count, target)); _code.Add(0); _code.Add(0); _code.Add(0); _code.Add(0); }
    public void Jmp(string target) { _code.Add(0xE9); _rel32.Add((_code.Count, target)); _code.Add(0); _code.Add(0); _code.Add(0); _code.Add(0); }
    public void Call(string target) { _code.Add(0xE8); _rel32.Add((_code.Count, target)); _code.Add(0); _code.Add(0); _code.Add(0); _code.Add(0); }

    public void RipMov(string reg, string target)
    {
        _code.AddRange(reg switch
        {
            "rax" => [0x48, 0x8B, 0x05],
            "rbx" => [0x48, 0x8B, 0x1D],
            "rcx" => [0x48, 0x8B, 0x0D],
            _ => throw new ArgumentOutOfRangeException(nameof(reg)),
        });
        _code.Add(0); _code.Add(0); _code.Add(0); _code.Add(0);
        _riprel.Add((_code.Count - 4, target));
    }

    public void RipLeaRbx(string target)
    {
        _code.AddRange([0x48, 0x8D, 0x1D]);
        _code.Add(0); _code.Add(0); _code.Add(0); _code.Add(0);
        _riprel.Add((_code.Count - 4, target));
    }

    public byte[] Build(out Il2CppResolver.BlobData data)
    {
        foreach (var (site, target) in _rel32)
        {
            Set32(site, _labels[target] - (site + 4));
        }
        foreach (var (site, target) in _riprel)
        {
            Set32(site, _labels[target] - (site + 4));
        }

        data = new Il2CppResolver.BlobData
        {
            Offset = 0,
            CodeSize = _labels["d0"],
            ApiSlots = [_labels["d0"], _labels["d1"], _labels["d2"], _labels["d3"], _labels["d4"], _labels["d5"], _labels["d6"], _labels["d7"]],
            K32GetModuleHandle = _labels["d_k32_gmh"],
            K32GetProcAddress = _labels["d_k32_gpa"],
            StrGameAssembly = _labels["d_str_ga"],
            ResolveTablePtr = _labels["d_restable_ptr"],
            ResolveTable = _labels["d_restable"],
        };
        return _code.ToArray();

        void Set32(int at, int v)
        {
            _code[at] = (byte)v;
            _code[at + 1] = (byte)(v >> 8);
            _code[at + 2] = (byte)(v >> 16);
            _code[at + 3] = (byte)(v >> 24);
        }
    }
}