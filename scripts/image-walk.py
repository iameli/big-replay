#!/usr/bin/env python3
"""Classic image -> classes[] route: find 'Assembly-CSharp' string in the module,
find image objects referencing it, walk the classes array to PlayerCharacter.
Pure reads."""
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
if not out.strip():
    print("NO GAME RUNNING")
    raise SystemExit
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
LO, HI = base, base + size

# 1) 'Assembly-CSharp' string inside the module
hits = []
pos = 0
while pos < size:
    chunk = read(h, base + pos, min(0x200000, size - pos))
    if chunk is None:
        break
    p = chunk.find(b"Assembly-CSharp\0")
    while p != -1:
        hits.append(base + pos + p)
        p = chunk.find(b"Assembly-CSharp\0", p + 1)
    pos += 0x200000
print("Assembly-CSharp strings in module:", [hex(x) for x in hits[:6]])


def cstr_any(addr, maxn=128):
    if not addr:
        return None
    b = read(h, addr, maxn)
    if not b or b[0] == 0:
        return None
    s = b.split(b"\0")[0]
    return s.decode("ascii", "replace") if all(32 <= c < 127 for c in s[:24]) else None


# 2) qwords in the module pointing at the string -> image candidates
found_classes = None
for target in hits[:2]:
    refs = []
    pos = 0
    needle = target.to_bytes(8, "little")
    while pos < size:
        chunk = read(h, base + pos, min(0x200000, size - pos))
        if chunk is None:
            break
        p = chunk.find(needle)
        while p != -1:
            refs.append(base + pos + p)
            p = chunk.find(needle, p + 1)
        pos += 0x200000
    print("image-name refs:", [hex(x) for x in refs[:8]])
    for r in refs[:8]:
        cand = r  # image.name at +0x00
        b = read(h, cand, 0x200)
        if not b:
            continue
        for off in range(0x30, 0x200, 8):
            P = u64(b, off)
            if not (LO <= P < HI):
                continue
            # P points at an array of qwords; check first 3 entries look like klass pointers
            names = []
            ok = True
            for j in range(3):
                k = u64(read(h, P + j * 8, 8) or b"\0" * 8, 0)
                nm = cstr_any(u64(read(h, k + 0x10, 8) or b"\0" * 8, 0)) if (LO <= k < HI) else None
                if nm is None:
                    ok = False
                    break
                names.append(nm)
            if ok:
                print(f"  image @ {cand:#x} classes @ {P:#x}: {names}")
                found_classes = (P, cand)
                break
        if found_classes:
            break
    if found_classes:
        break

if found_classes:
    P, img = found_classes
    idx = 0
    while idx < 60000:
        k = u64(read(h, P + idx * 8, 8) or b"\0" * 8, 0)
        nm = cstr_any(u64(read(h, k + 0x10, 8) or b"\0" * 8, 0))
        if nm is None:
            break
        if nm == "PlayerCharacter":
            st = u64(read(h, k + 0xB8, 8) or b"\0" * 8, 0)
            print(f"FOUND PlayerCharacter: klass={k:#x} index={idx} static_fields={st:#x}")
            break
        idx += 1