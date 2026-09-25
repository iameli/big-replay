#!/usr/bin/env python3
"""Re-verify username offsets: dump PlayerNetworking candidate fields as managed strings.
Pure reads. Reuses bootstrap discovery for the live entry."""
import ctypes, ctypes.wintypes as w, subprocess, json

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
def i32(b, o): return int.from_bytes(b[o:o + 4], "little", signed=True)


out = subprocess.run(["tasklist", "/fi", "imagename eq Big Walk.exe", "/fo", "csv", "/nh"], capture_output=True, text=True).stdout
pid = int(out.strip().splitlines()[0].split(",")[1].strip('"'))
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
for m in arr:
    nm = ctypes.create_string_buffer(260)
    psapi.GetModuleBaseNameA(h, m, nm, 260)
    if nm.value == b"GameAssembly.dll":
        mi = MI()
        psapi.GetModuleInformation(h, m, ctypes.byref(mi), ctypes.sizeof(mi))
        mod_base = mi.lpBaseOfDll
        break
print("pid", pid, "module", hex(mod_base))

manifest = json.load(open("manifest.json"))
pc = manifest["Classes"]["PlayerCharacter"]
pc_idx = pc["TypeIndex"]
pn_off = next(f["Offset"] for f in pc["Fields"] if f["Name"] == "playerNetworking")


def find_strings_near(handle, name):
    needle = name + b"\0"
    out = []
    for d in range(-0x2000000, 0x2000000, 0x100000):
        chunk = read(h, handle + d, 0x100000)
        if chunk:
            p = chunk.find(needle)
            while p != -1:
                out.append(handle + d + p)
                p = chunk.find(needle, p + 1)
    return out


def regions(lo, hi):
    addr = lo & ~0xFFFF
    while addr < hi:
        mbi = MBI()
        if kernel32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(MBI)) == 0:
            break
        ba = mbi.BaseAddress
        if mbi.State == 0x1000 and mbi.Protect in (0x04, 0x02, 0x40, 0x80, 0x20, 0x10):
            yield ba, ba + mbi.RegionSize
        addr = (ba + mbi.RegionSize + 0xFFFF) & ~0xFFFF
        if addr >= 0x7FFFFFFFF000:
            break


def scan_refs(needles, lo, hi):
    found = []
    for (ba, end) in regions(lo, hi):
        probe = ba
        while probe < end:
            nbytes = min(0x100000, end - probe)
            chunk = read(h, probe, nbytes)
            if chunk is None:
                break
            for nd in needles:
                p = chunk.find(nd)
                while p != -1:
                    found.append(probe + p)
                    p = chunk.find(nd, p + 1)
            probe += nbytes
    return found


def managed_string(obj):
    """Decode a .NET String object: len i32 @+0x10, UTF-16 chars @+0x14."""
    if not obj:
        return None
    ln = i32(read(h, obj + 0x10, 4) or b"\0" * 4, 0)
    if not (0 < ln <= 256):
        return None
    raw = read(h, obj + 0x14, ln * 2)
    if raw is None or len(raw) < ln * 2:
        return None
    return raw[: ln * 2].decode("utf-16-le", "replace")


# 1) bootstrap PlayerCharacter klass
handle = u64(read(h, mod_base + 0x3708230 + pc_idx * 8, 8) or b"\0" * 8, 0)
handle = u64(read(h, handle, 8) or b"\0" * 8, 0)
pc_strings = find_strings_near(handle, b"PlayerCharacter")
refs = scan_refs([s.to_bytes(8, "little") for s in pc_strings], 0x1000, 0x7FFFFFFFFFFF)
pc_klass = None
for r in refs:
    cand = r - 0x10
    b = read(h, cand, 0xC0)
    if b and u64(b, 0x78) == cand and u64(b, 0xB8):
        pc_klass = cand
        break
if not pc_klass:
    raise SystemExit("no player character in this process")
block = u64(read(h, pc_klass + 0xB8, 8) or b"\0" * 8, 0)
list_obj = u64(read(h, block, 8) or b"\0" * 8, 0)
items = u64(read(h, list_obj + 0x10, 8) or b"\0" * 8, 0)
entry = u64(read(h, items + 0x20, 8) or b"\0" * 8, 0)
pn_obj = u64(read(h, entry + pn_off, 8) or b"\0" * 8, 0)
print("entry", hex(entry), "pn_obj", hex(pn_obj))

# 2) dump all pointer fields in the PlayerNetworking object as managed strings
print("PlayerNetworking string fields:")
for off in range(0, 0x220, 8):
    q = u64(read(h, pn_obj + off, 8) or b"\0" * 8, 0)
    if not q:
        continue
    s = managed_string(q)
    if s is not None:
        print(f"  +{off:#x}: {s!r}")
# 3) raw dump of the first ~0x220 bytes as qwords for context
print("qword map:")
for off in range(0, 0x220, 8):
    q = u64(read(h, pn_obj + off, 8) or b"\0" * 8, 0)
    print(f"  +{off:#04x}: {q:#x}")