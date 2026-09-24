#!/usr/bin/env python3
"""Full payoff v2: bootstrap klasses via name-string refs (windowed), then ALL static blocks,
players with positions, monuments, gourds. Pure reads; live session."""
import ctypes, ctypes.wintypes as w, subprocess, json, math, struct

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


pid = 556884
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
classes = manifest["Classes"]
statics_off = {}
for name, ce in classes.items():
    for s in ce["Statics"]:
        statics_off[ce.get("image", "") + ":" + name + ":" + s["Name"]] = s["Offset"]


def type_handle(cls):
    ti = classes[cls]["TypeIndex"]
    tp = u64(read(h, mod_base + 0x3708230 + ti * 8, 8) or b"\0" * 8, 0)
    return u64(read(h, tp, 8) or b"\0" * 8, 0)


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


def ref_scan(needles, lo, hi):
    refs = []
    addr = lo & ~0xFFFF
    while addr < hi:
        mbi = MBI()
        if kernel32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(MBI)) == 0:
            break
        ba = mbi.BaseAddress
        if mbi.State == 0x1000 and mbi.Protect in (0x04, 0x02, 0x40, 0x80, 0x20, 0x10):
            cand_hi = min(ba + mbi.RegionSize, hi)
            probe = ba
            while probe < cand_hi:
                nbytes = min(0x100000, cand_hi - probe)
                chunk = read(h, probe, nbytes)
                if chunk is None:
                    break
                for nd in needles:
                    p = chunk.find(nd)
                    while p != -1:
                        refs.append(probe + p)
                        p = chunk.find(nd, p + 1)
                probe += nbytes
        addr = (ba + mbi.RegionSize + 0xFFFF) & ~0xFFFF
    return refs


def find_klass(cls, scope):
    handle = type_handle(cls)
    strings = find_strings_near(handle, cls.encode())
    refs = ref_scan([s.to_bytes(8, "little") for s in strings], *scope)
    for r in refs:
        cand = r - 0x10
        b = read(h, cand, 0xC0)
        if b and u64(b, 0x78) == cand:
            return cand, u64(b, 0xB8)
    return 0, 0


# ---- phase 1: PlayerCharacter klass (full scan), then window for the rest ----
full = (0, 0x7FFFFFFFF000)
pc_klass, pc_block = find_klass("PlayerCharacter", full)
print(f"PlayerCharacter: klass={pc_klass:#x} block={pc_block:#x}")
scope = (pc_klass - 0x4000000, pc_klass + 0x4000000)

for cls in ["NetworkServer", "NetworkClient", "PropHome", "Prop", "MainMenuManager", "PlayerNetworking", "Corpse"]:
    k, block = find_klass(cls, scope)
    if not k:
        k, block = find_klass(cls, full)  # rare: far away from the cluster
    print(f"{cls}: klass={k:#x} block={block:#x}")

# ---- phase 2: players ----
list_ptr = u64(read(h, pc_block, 8) or b"\0" * 8, 0)
items = u64(read(h, list_ptr + 0x10, 8) or b"\0" * 8, 0)
size = i32(read(h, list_ptr + 0x18, 4) or b"\0" * 4, 0)
print(f"players list: {size}")
nb_off = next(f["Offset"] for f in classes["NetworkBehaviour"]["Fields"] if f["Name"] == "<netIdentity>k__BackingField")
ni_off = next(f["Offset"] for f in classes["NetworkIdentity"]["Fields"] if f["Name"] == "<netId>k__BackingField")


def world_pos(cs):
    native = u64(read(h, cs + 0x10, 8) or b"\0" * 8, 0)
    go = u64(read(h, native + 0x20, 8) or b"\0" * 8, 0)
    comps = u64(read(h, go + 0x20, 8) or b"\0" * 8, 0)
    tr = u64(read(h, comps + 0x08, 8) or b"\0" * 8, 0)
    if not tr:
        return None
    state = u64(read(h, tr + 0x28, 8) or b"\0" * 8, 0)
    node = u64(read(h, state + 0x18, 8) or b"\0" * 8, 0)
    pars = u64(read(h, state + 0x20, 8) or b"\0" * 8, 0)
    idx = i32(read(h, tr + 0x30, 4) or b"\0" * 4, 0)
    chain = []
    seen = set()
    i = idx
    while i not in seen:
        seen.add(i)
        chain.append(i)
        if i == 0:
            break
        p = i32(read(h, pars + 4 * i, 4) or b"\0" * 4, 0)
        if p < 0 or p > 1000000:
            return None
        i = p
    chain.reverse()
    x = y = z = 0.0
    qx = qy = qz = 0.0
    qw = 1.0
    for nidx in chain:
        a = node + nidx * 0x30
        lx, ly, lz = struct.unpack_from("<3f", read(h, a + 0x00, 12))
        lqx, lqy, lqz, lqw2 = struct.unpack_from("<4f", read(h, a + 0x10, 16))
        lsx, lsy, lsz = struct.unpack_from("<3f", read(h, a + 0x20, 12))
        tx = 2 * (qy * lz * lsz - qz * ly * lsy)
        ty = 2 * (qz * lx * lsx - qx * lz * lsz)
        tz = 2 * (qx * ly * lsy - qy * lx * lsx)
        x += lx * lsx + qw * tx + (qy * tz - qz * ty)
        y += ly * lsy + qw * ty + (qz * tx - qx * tz)
        z += lz * lsz + qw * tz + (qx * ty - qy * tx)
        nx = qw * lqx + qx * lqw + qy * lqz - qz * lqy
        ny = qw * lqy - qx * lqz + qy * lqw + qz * lqx
        nz = qw * lqz + qx * lqy - qy * lqx + qz * lqw
        nw = qw * lqw - qx * lqx - qy * lqy - qz * lqz
        qx, qy, qz, qw = nx, ny, nz, nw
    yaw = math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz))
    return x, y, z, yaw


for i in range(min(size, 16)):
    entry = u64(read(h, items + 0x20 + i * 8, 8) or b"\0" * 8, 0)
    if not entry:
        continue
    ni_obj = u64(read(h, entry + nb_off, 8) or b"\0" * 8, 0)
    netid = u64(read(h, ni_obj + ni_off, 8) or b"\0" * 8, 0) if ni_obj else 0
    wp = world_pos(entry)
    print(f"player[{i}] netId={netid} pos={tuple(round(v, 2) for v in wp) if wp else None}")