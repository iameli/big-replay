#!/usr/bin/env python3
"""Fine-grained static-block chain diagnostics (pure reads only)."""
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


out = subprocess.run(["tasklist", "/fi", "imagename eq Big Walk.exe", "/fo", "csv", "/nh"], capture_output=True, text=True).stdout
pid = int(out.strip().splitlines()[0].split(",")[1].strip('"'))
h = kernel32.OpenProcess(0x143A, False, pid)
print("pid", pid, "open", bool(h))

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
print("GameAssembly base", hex(base))

TYPES_TABLE_RVA = 0x3708230  # manifest.json TypesTableRva
def in_module(a):
    return BASE <= a < END


TYPES_TABLE_RVA = 0x3708230  # manifest.json TypesTableRva
STATIC_FIELDS_OFF = 0xB8
BASE = 0x7ff89b640000
END = BASE + 0x4652000
for name, ti in [("PlayerCharacter", 5498), ("Prop", 5578), ("PropHome", 5554),
                 ("NetworkClient", 18317), ("NetworkServer", 18349), ("MainMenuManager", 5311)]:
    print(f"-- {name} (manifest typeIndex {ti})")
    for delta in (-1, 0, 1):
        idx = ti + delta
        b = read(h, base + TYPES_TABLE_RVA + idx * 8, 8)
        if b is None:
            continue
        typePtr = u64(b, 0)
        if not typePtr:
            print(f"  idx {idx}: typePtr=0")
            continue
        klass = u64(read(h, typePtr, 8) or b"\0" * 8, 0)
        sf = 0
        if klass:
            sf_b = read(h, klass + STATIC_FIELDS_OFF, 8)
            sf = u64(sf_b, 0) if sf_b else 0
        mark = " <== IN MODULE" if in_module(klass) else ""
        print(f"  idx {idx}: typePtr={typePtr:#016x} klass={klass:#016x} sf={sf:#x}{mark}")