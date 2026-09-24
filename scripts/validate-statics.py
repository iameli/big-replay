#!/usr/bin/env python3
"""Validate offline aligned static-block offsets against live Mirror static blocks.
Pure reads only."""
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
print("base", hex(base))

types_table = base + 0x3708230  # manifest TypesTableRva (stable for this build)
manifest = json.load(open("manifest.json"))
classes = manifest["Classes"]

for cls in ["NetworkClient", "NetworkServer"]:
    entry = classes[cls]
    ti = entry["TypeIndex"]
    typePtr = u64(read(h, types_table + ti * 8, 8) or b"\0" * 8, 0)
    klass = u64(read(h, typePtr, 8) or b"\0" * 8, 0)
    block = u64(read(h, klass + 0xB8, 8) or b"\0" * 8, 0) if klass else 0
    print(f"== {cls}: klass={klass:#x} static block={block:#x}")
    if not block:
        print("   (static block not allocated yet)")
        continue
    for s in entry["Statics"]:
        addr = block + s["Offset"]
        if s["Size"] == 1:
            val = read(h, addr, 1)[0]
        elif s["Size"] == 4:
            val = i32(read(h, addr, 4) or b"\0" * 4, 0)
        else:
            val = u64(read(h, addr, 8) or b"\0" * 8, 0)
        print(f"   {s['Name']}({s['Size']}B@0x{s['Offset']:x}) = {val:#x}")