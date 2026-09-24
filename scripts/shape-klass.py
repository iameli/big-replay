#!/usr/bin/env python3
"""Find ALL real Il2CppClass objects by shape: scan module .data/.il2cpp for qwords pointing
into the metadata image, validate as klass (self@0x78, image@0x00, name@0x10). Pure reads."""
import ctypes, ctypes.wintypes as w, subprocess, sys

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.OpenProcess.restype = ctypes.c_void_p
kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_uint32]
kernel32.ReadProcessMemory.restype = ctypes.c_bool
kernel32.ReadProcessMemory.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]


def read(h, addr, n):
    buf = ctypes.create_string_buffer(n)
    got = ctypes.c_size_t(0)
    if not kernel32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, n, ctypes.byref(got)):
        return None
    return buf.raw[:got.value]


def u64(b, o): return int.from_bytes(b[o:o + 8], "little")


pid = int(sys.argv[1])
h = kernel32.OpenProcess(0x143A, False, pid)
psapi = ctypes.WinDLL("psapi")
n = w.DWORD(0)
psapi.EnumProcessModulesEx.argtypes = [w.HANDLE, ctypes.POINTER(ctypes.c_void_p), w.DWORD, ctypes.POINTER(w.DWORD), w.DWORD]
psapi.EnumProcessModulesEx(h, None, 0, ctypes.byref(n), 3)
arr = (ctypes.c_void_p * (n.value // 8))()
psapi.EnumProcessModulesEx(h, arr, n.value, ctypes.byref(n), 3)
psapi.GetModuleBaseNameA.argtypes = [w.HANDLE, ctypes.c_void_p, ctypes.c_char_p, w.DWORD]
base = 0
size = 0
for m in arr:
    nm = ctypes.create_string_buffer(260)
    psapi.GetModuleBaseNameA(h, m, nm, 260)
    if nm.value == b"GameAssembly.dll":
        from ctypes import Structure
        class MI(Structure):
            _fields_ = [("lpBaseOfDll", ctypes.c_void_p), ("SizeOfImage", w.DWORD), ("EntryPoint", ctypes.c_void_p)]
        psapi.GetModuleInformation.argtypes = [w.HANDLE, ctypes.c_void_p, ctypes.POINTER(MI), w.DWORD]
        mi = MI()
        psapi.GetModuleInformation(h, m, ctypes.byref(mi), ctypes.sizeof(mi))
        base = mi.lpBaseOfDll
        size = mi.SizeOfImage
        break
print("module", hex(base), hex(size))
HI = base + size

# metadata image range (from typeHandles: 0x15b9400_0000-ish; recompute loose bounds)
META_LO = 0x15b90000000
META_HI = 0x15bb0000000


def cstr_any(addr, maxn=96):
    if not addr or not (META_LO <= addr < META_HI):
        return None
    b = read(h, addr, maxn)
    if not b:
        return None
    s = b.split(b"\0")[0]
    return s.decode("ascii", "replace") if all(32 <= c < 127 for c in s[:24]) else None


found = []
pos = 0
while pos < size:
    chunk = read(h, base + pos, min(0x100000, size - pos))
    if chunk is None:
        break
    # iterate qwords; where value points into the metadata image, treat as name-field candidate
    for k in range(0, len(chunk) - 8, 8):
        v = u64(chunk, k)
        if not (META_LO <= v < META_HI):
            continue
        cand = base + pos + k - 0x10
        if cand < base:
            continue
        # shape check: self pointer @0x78 == cand; image @0x00 in-module; byval type byte @0x2C
        b = read(h, cand, 0x80)
        if not b:
            continue
        selfp = u64(b, 0x78)
        img = u64(b, 0x00)
        if selfp != cand or not (base <= img < HI):
            continue
        nm = cstr_any(v)
        st = u64(read(h, cand + 0xB8, 8) or b"\0" * 8, 0)
        found.append((cand, nm, st))
    pos += 0x100000

print("klass-shaped objects:", len(found))
for cand, nm, st in found[:60]:
    print(f"  klass {cand:#x}: name={nm!r} static_fields={st:#x}")