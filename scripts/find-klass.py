#!/usr/bin/env python3
"""Anatomically locate Il2CppClass objects: find the class name string in the module,
then find .data qwords pointing at it (candidate klass.name), validate klass shape.
Pure reads only."""
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
print(f"module {base:#x} size {size:#x}")


def scan_bytes(hay_range, needle):
    found = []
    pos = 0
    while pos < len(hay_range):
        b = read(h, hay_range[pos], min(0x40000, 0x40000))
        if not b:
            break
        get = b.find(needle)
        while get != -1:
            found.append(hay_range[pos] + get)
            get = b.find(needle, get + 1)
        pos += 0x40000
    return found


# 1) locate the class name string (in .rdata/.data area)
NAME = b"NetworkServer\x00"
hits = scan_bytes(list(range(base, base + size, 0x40000)), NAME)
print("name string at:", [hex(x) for x in hits[:6]])
if not hits:
    raise SystemExit("name not found")
target = hits[0]

# 2) find module qwords pointing at the name -> candidates referencing klass.name
refs = scan_bytes(list(range(base, base + size, 0x40000)), target.to_bytes(8, "little"))
print("qword refs to name:", len(refs), [hex(x) for x in refs[:12]])

# 3) validate candidate klass structs (name at +0x10, namespaze at +0x18 -> "Mirror")
for r in refs[:40]:
    cand = r - 0x10
    b = read(h, cand, 0xC8)
    if not b:
        continue
    ns_q = u64(b, 0x18)
    ns_b = read(h, ns_q, 16)
    ns = ns_b.split(b"\0")[0].decode("ascii", "replace") if ns_b else "?"
    fs = u64(b, 0x48)
    st = u64(b, 0xB8)
    flag = "  <== plausible klass" if ns == "Mirror" else ""
    print(f"cand @ {cand:#x}: ns='{ns}' fields={fs:#x} static_fields={st:#x}{flag}")