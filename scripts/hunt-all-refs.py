#!/usr/bin/env python3
"""Full ref scan against ALL 'PlayerCharacter' string copies in the live process. Pure reads."""
import ctypes, ctypes.wintypes as w, subprocess, sys

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


pid = int(sys.argv[1])
h = kernel32.OpenProcess(0x143A, False, pid)
targets = [0x15b94467007, 0x15b9446a93e, 0x15b9446a958, 0x15b9446aa5d, 0x15b9446ac8e,
           0x15b94473067, 0x15b94476c7f, 0x15b9447e6c6, 0x15b9447e6f6, 0x15b9447f180,
           0x15b9447f1b8, 0x15b9454db97, 0x15b94cc632b]
needles = sorted({t.to_bytes(8, "little") for t in targets})

refs = []
addr = 0
regions = 0
while True:
    mbi = MBI()
    if kernel32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(MBI)) == 0:
        break
    ba = mbi.BaseAddress
    regions += 1
    if mbi.State == 0x1000 and mbi.Protect in (0x04, 0x02, 0x40, 0x80, 0x20, 0x10):
        region = mbi.RegionSize
        probe = 0
        while probe < region:
            nbytes = min(0x100000, region - probe)
            chunk = read(h, ba + probe, nbytes)
            if chunk is None:
                break
            for nd in needles:
                pos = chunk.find(nd)
                while pos != -1:
                    refs.append(ba + probe + pos)
                    pos = chunk.find(nd, pos + 1)
            probe += nbytes
    addr = (ba + mbi.RegionSize + 0xFFFF) & ~0xFFFF
    if addr >= 0x7FFFFFFFF000:
        break

print("regions:", regions, "refs:", len(refs))
seen = set()
for r in refs[:100]:
    cand = r - 0x10
    if cand in seen:
        continue
    seen.add(cand)
    b = read(h, cand, 0xC0)
    if not b:
        continue
    img = u64(b, 0x00)
    ns_b = read(h, u64(b, 0x18), 64)
    ns = ns_b.split(b"\0")[0].decode("ascii", "replace") if ns_b else "?"
    st = u64(b, 0xB8)
    klass = u64(b, 0x78)
    print(f"cand {cand:#x}: image={img:#x} ns={ns!r} static_fields@0xB8={st:#x} self@0x78={klass:#x}")