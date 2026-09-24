#!/usr/bin/env python3
"""Find the real Il2CppClass by scanning ALL readable memory for qwords pointing at the
known 'PlayerCharacter' strings, then validating candidates. Pure reads."""
import ctypes, ctypes.wintypes as w, subprocess

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.OpenProcess.restype = ctypes.c_void_p
kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_uint32]
kernel32.ReadProcessMemory.restype = ctypes.c_bool
kernel32.ReadProcessMemory.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
kernel32.VirtualQueryEx.restype = ctypes.c_size_t
kernel32.VirtualQueryEx.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_size_t), ("AllocationBase", ctypes.c_size_t),
                ("AllocationProtect", w.DWORD), ("Align4", w.DWORD),
                ("RegionSize", ctypes.c_size_t), ("State", w.DWORD),
                ("Protect", w.DWORD), ("Type", w.DWORD)]


def read(h, addr, n):
    buf = ctypes.create_string_buffer(n)
    got = ctypes.c_size_t(0)
    if not kernel32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, n, ctypes.byref(got)):
        return None
    return buf.raw[:got.value]


def u64(b, o): return int.from_bytes(b[o:o + 8], "little")


out = subprocess.run(["tasklist", "/fi", "imagename eq Big Walk.exe", "/fo", "csv", "/nh"], capture_output=True, text=True).stdout
pid = int(out.strip().splitlines()[0].split(",")[1].strip('"'))
h = kernel32.OpenProcess(0x143A, False, pid)

targets = {0x1e99e41632b, 0x1e99e420f13}

refs = []
addr = 0
regions = 0
while True:
    mbi = MBI()
    if kernel32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(MBI)) == 0:
        break
    base_addr = mbi.BaseAddress
    regions += 1
    if mbi.State == 0x1000 and mbi.Protect in (0x04, 0x02, 0x40, 0x80, 0x20, 0x10):
        region = mbi.RegionSize
        probe = 0
        while probe < region:
            nbytes = min(0x200000, region - probe)
            chunk = read(h, base_addr + probe, nbytes)
            if chunk is None:
                break
            for t in targets:
                needle = t.to_bytes(8, "little")
                pos = chunk.find(needle)
                while pos != -1:
                    refs.append((base_addr + probe + pos, t))
                    pos = chunk.find(needle, pos + 1)
            probe += nbytes
    addr = (base_addr + mbi.RegionSize + 0xFFFF) & ~0xFFFF
    if addr >= 0x7FFFFFFFF000:
        break

print("regions:", regions, "refs:", len(refs))
for r, t in refs[:60]:
    cand = r - 0x10
    b = read(h, cand, 0x100)
    if not b:
        continue
    img = u64(b, 0x00)
    ns_b = read(h, u64(b, 0x18), 128)
    ns = ns_b.split(b"\0")[0].decode("ascii", "replace") if ns_b else "?"
    st = u64(b, 0xB8)
    print(f"cand {cand:#x}: image={img:#x} ns={ns!r} static_fields@0xB8={st:#x}")