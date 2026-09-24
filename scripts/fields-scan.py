#!/usr/bin/env python3
"""Find Il2CppClass.fields pointer offset empirically and dump real static-block offsets.
Pure reads only. Uses NetworkClient/NetworkServer klasses (which DO exist pre-lobby)."""
import ctypes, ctypes.wintypes as w, subprocess

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
psapi = ctypes.WinDLL("psapi", use_last_error=True)

kernel32.OpenProcess.restype = ctypes.c_void_p
kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_uint32]
kernel32.ReadProcessMemory.restype = ctypes.c_bool
kernel32.ReadProcessMemory.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
psapi.EnumProcessModulesEx.restype = w.BOOL
psapi.EnumProcessModulesEx.argtypes = [w.HANDLE, ctypes.POINTER(ctypes.c_void_p), w.DWORD, ctypes.POINTER(w.DWORD), w.DWORD]
psapi.GetModuleBaseNameA.restype = w.DWORD
psapi.GetModuleBaseNameA.argtypes = [w.HANDLE, ctypes.c_void_p, ctypes.c_char_p, w.DWORD]


class MI(ctypes.Structure):
    _fields_ = [("lpBaseOfDll", ctypes.c_void_p), ("SizeOfImage", w.DWORD), ("EntryPoint", ctypes.c_void_p)]


psapi.GetModuleInformation.argtypes = [w.HANDLE, ctypes.c_void_p, ctypes.POINTER(MI), w.DWORD]


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
n = w.DWORD(0)
psapi.EnumProcessModulesEx(h, None, 0, ctypes.byref(n), 3)
arr = (ctypes.c_void_p * (n.value // 8))()
psapi.EnumProcessModulesEx(h, arr, n.value, ctypes.byref(n), 3)
base = 0
for m in arr:
    nm = ctypes.create_string_buffer(260)
    psapi.GetModuleBaseNameA(h, m, nm, 260)
    if nm.value == b"GameAssembly.dll":
        mi = MI()
        psapi.GetModuleInformation(h, m, ctypes.byref(mi), ctypes.sizeof(mi))
        base = mi.lpBaseOfDll
        break
MOD_LO = base
MOD_HI = base + 0x4652000

# klasses found by chain-diagnose (valid in-module Il2CppClass):
K = {
    "NetworkClient": 0x7ff89f43af98,
    "NetworkServer": 0x7ff89f43b818,
}


def read_cstr(addr, maxlen=128):
    if not addr or not (MOD_LO <= addr < MOD_HI):
        return None
    return read(h, addr, maxlen).split(b"\0")[0].decode("ascii", "replace")


for cls_name, klass in K.items():
    found = None
    for off in range(0x40, 0x240, 8):
        P = u64(read(h, klass + off, 8) or b"\0" * 8, 0)
        if not P or not (MOD_LO <= P < MOD_HI):
            continue
        # entry 0 name ptr
        name0 = u64(read(h, P, 8) or b"\0" * 8, 0)
        s = read_cstr(name0)
        if not s or len(s) < 2:
            continue
        # verify a couple of consecutive entries are field names (printable, ascii)
        nmbrs = []
        for i in range(6):
            e = P + i * 0x20
            nmp = u64(read(h, e, 8) or b"\0" * 8, 0)
            nmbrs.append(read_cstr(nmp))
        if any(x is None for x in nmbrs[:2]):
            continue
        found = (off, P, nmbrs)
        break
    print(f"== {cls_name} klass={klass:#x}")
    if not found:
        print("   fields pointer not located")
        continue
    off, P, first_names = found
    print(f"   [Il2CppClass+0x{off:X}] = fields @ {P:#x}; first names: {first_names[:4]}")
    # scan entries for the target fields and dump offset+token
    for i in range(0, 512):
        e = P + i * 0x20
        nmp = u64(read(h, e, 8) or b"\0" * 8, 0)
        nm = read_cstr(nmp)
        if nm is None:
            break
        ftype = u64(read(h, e + 8, 8) or b"\0" * 8, 0)
        foff = i32(read(h, e + 0x18, 4) or b"\0" * 4, 0)
        tok = i32(read(h, e + 0x1C, 4) or b"\0" * 4, 0)
        print(f"   field[{i:3}] {nm[:40]:40s} type={ftype:#x} offset={foff:#x} token={tok:#x}")