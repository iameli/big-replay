#!/usr/bin/env python3
"""Per-process hunt: locate 'PlayerCharacter' string near the live typeHandle, then full-space
ref scan -> real klass (+ static block). Pure reads. Usage: hunt-klass2.py <pid>"""
import ctypes, ctypes.wintypes as w, subprocess, sys, json

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

# module base
psapi = ctypes.WinDLL("psapi")
n = w.DWORD(0)
psapi.EnumProcessModulesEx.argtypes = [w.HANDLE, ctypes.POINTER(ctypes.c_void_p), w.DWORD, ctypes.POINTER(w.DWORD), w.DWORD]
psapi.EnumProcessModulesEx(h, None, 0, ctypes.byref(n), 3)
arr = (ctypes.c_void_p * (n.value // 8))()
psapi.EnumProcessModulesEx(h, arr, n.value, ctypes.byref(n), 3)
psapi.GetModuleBaseNameA.argtypes = [w.HANDLE, ctypes.c_void_p, ctypes.c_char_p, w.DWORD]
base = 0
for m in arr:
    nm = ctypes.create_string_buffer(260)
    psapi.GetModuleBaseNameA(h, m, nm, 260)
    if nm.value == b"GameAssembly.dll":
        base = m
        break
print("pid", pid, "module", hex(base))

manifest = json.load(open("manifest.json"))
ti = manifest["Classes"]["PlayerCharacter"]["TypeIndex"]
typePtr = u64(read(h, base + 0x3708230 + ti * 8, 8) or b"\0" * 8, 0)
handle = u64(read(h, typePtr, 8) or b"\0" * 8, 0)
print("typeHandle", hex(handle))

# 1) PlayerCharacter string near the handle (metadata image region)
needle = b"PlayerCharacter\0"
str_hits = []
for d in range(-0x800000, 0x800000, 0x100000):
    chunk = read(h, handle + d, 0x100000)
    if chunk:
        pos = chunk.find(needle)
        while pos != -1:
            str_hits.append(handle + d + pos)
            pos = chunk.find(needle, pos + 1)
print("string hits:", [hex(x) for x in str_hits])
if not str_hits:
    raise SystemExit("string not found")

targets = set(str_hits)
refs = []
addr = 0
while True:
    mbi = MBI()
    if kernel32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(MBI)) == 0:
        break
    ba = mbi.BaseAddress
    if mbi.State == 0x1000 and mbi.Protect in (0x04, 0x02, 0x40, 0x80, 0x20, 0x10):
        region = mbi.RegionSize
        probe = 0
        while probe < region:
            nbytes = min(0x200000, region - probe)
            chunk = read(h, ba + probe, nbytes)
            if chunk is None:
                break
            for t in targets:
                nd = t.to_bytes(8, "little")
                pos = chunk.find(nd)
                while pos != -1:
                    refs.append((ba + probe + pos, t))
                    pos = chunk.find(nd, pos + 1)
            probe += nbytes
    addr = (ba + mbi.RegionSize + 0xFFFF) & ~0xFFFF
    if addr >= 0x7FFFFFFFF000:
        break

print("refs:", len(refs))
seen = set()
for r, t in refs[:80]:
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
    print(f"cand {cand:#x}: image={img:#x} ns={ns!r} static_fields@0xB8={st:#x}")