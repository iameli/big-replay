#!/usr/bin/env python3
"""Deep-validate the Mirror klass candidates: image name, cctor_finished, static block +
field reads on the CURRENT process. Pure reads only."""
import ctypes, ctypes.wintypes as w, json, subprocess

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
def u32(b, o): return int.from_bytes(b[o:o + 4], "little")


out = subprocess.run(["tasklist", "/fi", "imagename eq Big Walk.exe", "/fo", "csv", "/nh"], capture_output=True, text=True).stdout
pid = int(out.strip().splitlines()[0].split(",")[1].strip('"'))
h = kernel32.OpenProcess(0x143A, False, pid)

n = w.DWORD(0)
psapi.EnumProcessModulesEx(h, None, 0, ctypes.byref(n), 3)
count = n.value // 8
arr = (ctypes.c_void_p * count)()
psapi.EnumProcessModulesEx(h, arr, count * 8, ctypes.byref(n), 3)
base = 0
for m in arr:
    nm = ctypes.create_string_buffer(260)
    psapi.GetModuleBaseNameA(h, m, nm, 260)
    if nm.value == b"GameAssembly.dll":
        mi = MI()
        psapi.GetModuleInformation(h, m, ctypes.byref(mi), ctypes.sizeof(mi))
        base = mi.lpBaseOfDll
        break
MOD_LO, MOD_HI = base, base + 0x4652000
types_table = base + 0x3708230
manifest = json.load(open("manifest.json"))
print(f"module {base:#x}")


def cstr(addr, maxn=96):
    if not addr or not (MOD_LO <= addr < MOD_HI):
        return None
    b = read(h, addr, maxn)
    return b.split(b"\0")[0].decode("ascii", "replace") if b else None


for cls in ["NetworkClient", "NetworkServer"]:
    ti = manifest["Classes"][cls]["TypeIndex"]
    typePtr = u64(read(h, types_table + ti * 8, 8) or b"\0" * 8, 0)
    data = u64(read(h, typePtr, 8) or b"\0" * 8, 0) if typePtr else 0
    print(f"== {cls}: typePtr={typePtr:#x}")
    if not data or not (MOD_LO <= data < MOD_HI):
        print("   data not in module — type-less (not a klass candidate)")
        continue
    b = read(h, data, 0x40)
    img = u64(b, 0x00)
    imgname = cstr(u64(read(h, img, 8) or b"\0" * 8, 0)) if img else None
    elem = u64(b, 0x40 - 0x40) if False else None
    cc = u32(read(h, data + 0xE0, 4) or b"\0" * 4, 0)
    st = u64(read(h, data + 0xB8, 8) or b"\0" * 8, 0)
    print(f"   data={data:#x} image={img:#x} imageName={imgname} cctor_finished@0xE0={cc} static_fields@0xB8={st:#x}")
    if st and cc == 1:
        print("   == KLASS CONFIRMED (image name + cctor ran + static block)");