#!/usr/bin/env python3
"""Find the CORRECT runtime type-table index for our classes by scanning for klass identity
(name@0x10 via signature-verified layout), exploiting the in-world session. Pure reads."""
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


def cstr_any(addr):
    if not addr:
        return None
    b = read(h, addr, 96)
    if not b or b[0] == 0:
        return None
    s = b.split(b"\0")[0]
    return s if all(32 <= c < 127 for c in s[:16]) else None


out = subprocess.run(["tasklist", "/fi", "imagename eq Big Walk.exe", "/fo", "csv", "/nh"], capture_output=True, text=True).stdout
pid = int(out.strip().splitlines()[0].split(",")[1].strip('"'))
h = kernel32.OpenProcess(0x143A, False, pid)

n = w.DWORD(0)
psapi.EnumProcessModulesEx(h, None, 0, ctypes.byref(n), 3)
count = n.value // 8
arr = (ctypes.c_void_p * count)()
psapi.EnumProcessModulesEx(h, arr, count * 8, ctypes.byref(n), 3)
base = 0
size = 0
for m in arr:
    nm = ctypes.create_string_buffer(260)
    psapi.GetModuleBaseNameA(h, m, nm, 260)
    if nm.value == b"GameAssembly.dll":
        mi = MI()
        psapi.GetModuleInformation(h, m, ctypes.byref(mi), ctypes.sizeof(mi))
        base = mi.lpBaseOfDll
        size = mi.SizeOfImage
        break
print(f"module {base:#x}")
targets = {b"PlayerCharacter", b"NetworkClient", b"NetworkServer", b"PropHome", b"MainMenuManager", b"Prop", b"PlayerNetworking"}

TYPES_RVA = 0x3708230
TYPES_COUNT = 0x1239F  # numTypes from the manifest

found = {}
for idx in range(TYPES_COUNT):
    tp = u64(read(h, base + TYPES_RVA + idx * 8, 8) or b"\0" * 8, 0)
    if not tp:
        continue
    data = u64(read(h, tp, 8) or b"\0" * 8, 0)
    if not data:
        continue
    name = cstr_any(u64(read(h, data + 0x10, 8) or b"\0" * 8, 0))
    if name in targets:
        found[name.decode()] = idx
        block = u64(read(h, data + 0xB8, 8) or b"\0" * 8, 0)
        print(f"MATCH {name.decode()}: index {idx}, klass={data:#x}, block={block:#x}")

print("all found:", found)