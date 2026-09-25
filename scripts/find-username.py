#!/usr/bin/env python3
"""Find the username field on PlayerNetworking: bootstrap to the live player's
PlayerNetworking object, scan its fields for a pointer to the UTF-16 'iameli' string.
Pure reads."""
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
print("module", hex(mod_base))

manifest = json.load(open("manifest.json"))
pc = manifest["Classes"]["PlayerCharacter"]
pn = manifest["Classes"]["PlayerNetworking"]
pn_off = next(f["Offset"] for f in pc["Fields"] if f["Name"] == "playerNetworking")
pc_idx = pc["TypeIndex"]


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
            yield ba, min(ba + mbi.RegionSize, hi) - ba
        addr = (ba + mbi.RegionSize + 0xFFFF) & ~0xFFFF
        if addr >= 0x7FFFFFFFF000:
            break


def scan_refs(needles, lo, hi):
    found = []
    for (ba, sz) in regions(lo, hi):
        probe = ba
        end = ba + sz
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


# 1) bootstrapping: PlayerCharacter klass (full pass)
handle = u64(read(h, mod_base + 0x3708230 + pc_idx * 8, 8) or b"\0" * 8, 0)
handle = u64(read(h, handle, 8) or b"\0" * 8, 0)
pc_strings = find_strings_near(handle, b"PlayerCharacter")
refs = scan_refs([s.to_bytes(8, "little") for s in pc_strings], 0x1000, 0x7FFFFFFFFFFF)
pc_klass = 0
for r in refs:
    cand = r - 0x10
    b = read(h, cand, 0xC0)
    if b and u64(b, 0x78) == cand and u64(b, 0xB8):
        pc_klass = cand
        break
print("PC klass:", hex(pc_klass) if pc_klass else "none")
if not pc_klass:
    raise SystemExit("no player character (are you in-world?)")

block = u64(read(h, pc_klass + 0xB8, 8) or b"\0" * 8, 0)
list_obj = u64(read(h, block, 8) or b"\0" * 8, 0)
items = u64(read(h, list_obj + 0x10, 8) or b"\0" * 8, 0)
size = i32(read(h, list_obj + 0x18, 4) or b"\0" * 4, 0)
print("players:", size)
entry = u64(read(h, items + 0x20, 8) or b"\0" * 8, 0)
pn_obj = u64(read(h, entry + pn_off, 8) or b"\0" * 8, 0)
print("entry:", hex(entry), "PlayerNetworking obj:", hex(pn_obj))

# 2) scan the PlayerNetworking object's fields for pointers to UTF-16 'iameli'
needle_u16 = "iameli".encode("utf-16-le")
hits = []
for off in range(0, 0x300, 8):
    q = u64(read(h, pn_obj + off, 8) or b"\0" * 8, 0)
    if not q:
        continue
    raw = read(h, q, 96)
    if raw and needle_u16 in raw:
        s = raw.split(b"\0\0")[0].decode("utf-16-le", "replace")
        print(f"  PlayerNetworking +{off:#x} -> utf16 string {s!r}")
        hits.append((off, q))

# 3) also scan the entry object region (fallback: field may live on PlayerCharacter)
for off in range(0, 0x300, 8):
    q = u64(read(h, entry + off, 8) or b"\0" * 8, 0)
    if not q:
        continue
    raw = read(h, q, 96)
    if raw and needle_u16 in raw:
        s = raw.split(b"\0\0")[0].decode("utf-16-le", "replace")
        print(f"  PlayerCharacter +{off:#x} -> utf16 string {s!r}")
        hits.append((off, q))

print("found", len(hits), "username refs")