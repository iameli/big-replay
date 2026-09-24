#!/usr/bin/env python3
"""Full-space klass shape scan: candidates with self@0x78, in-module image@0x00, name ptr into
metadata image. Validates the model on ANY class, then reports our targets. Pure reads."""
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
psapi = ctypes.WinDLL("psapi")
n = w.DWORD(0)
psapi.EnumProcessModulesEx.argtypes = [w.HANDLE, ctypes.POINTER(ctypes.c_void_p), w.DWORD, ctypes.POINTER(w.DWORD), w.DWORD]
psapi.EnumProcessModulesEx(h, None, 0, ctypes.byref(n), 3)
arr = (ctypes.c_void_p * (n.value // 8))()
psapi.EnumProcessModulesEx(h, arr, n.value, ctypes.byref(n), 3)
psapi.GetModuleBaseNameA.argtypes = [w.HANDLE, ctypes.c_void_p, ctypes.c_char_p, w.DWORD]
from ctypes import Structure


class MI(Structure):
    _fields_ = [("lpBaseOfDll", ctypes.c_void_p), ("SizeOfImage", w.DWORD), ("EntryPoint", ctypes.c_void_p)]


psapi.GetModuleInformation.argtypes = [w.HANDLE, ctypes.c_void_p, ctypes.POINTER(MI), w.DWORD]
mod_base = 0
mod_size = 0
for m in arr:
    nm = ctypes.create_string_buffer(260)
    psapi.GetModuleBaseNameA(h, m, nm, 260)
    if nm.value == b"GameAssembly.dll":
        mi = MI()
        psapi.GetModuleInformation(h, m, ctypes.byref(mi), ctypes.sizeof(mi))
        mod_base = mi.lpBaseOfDll
        mod_size = mi.SizeOfImage
        break
print("module", hex(mod_base))
META_LO, META_HI = 0x15b90000000, 0x15bb0000000

wanted = {b"PlayerCharacter", b"NetworkClient", b"NetworkServer", b"PropHome", b"System.String"}

found = []
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
            for k in range(0, len(chunk) - 8, 8):
                v = u64(chunk, k)
                if not (META_LO <= v < META_HI):
                    continue
                cand = ba + probe + k - 0x10
                if cand < 0:
                    continue
                b = read(h, cand, 0x80)
                if not b:
                    continue
                if u64(b, 0x78) != cand:
                    continue
                img = u64(b, 0x00)
                if not (mod_base <= img < mod_base + mod_size):
                    continue
                name_b = read(h, v, 64)
                if not name_b:
                    continue
                nm = name_b.split(b"\0")[0]
                if not nm or not all(32 <= c < 127 for c in nm[:24]):
                    continue
                found.append((cand, nm))
            probe += nbytes
    addr = (ba + mbi.RegionSize + 0xFFFF) & ~0xFFFF
    if addr >= 0x7FFFFFFFF000:
        break

print("regions:", regions, "klass-shaped objects:", len(found))
for cand, nm in found[:80]:
    mark = " <== TARGET" if nm[:24] in wanted else ""
    print(f"  {cand:#x}: {nm[:40]!r}{mark}")