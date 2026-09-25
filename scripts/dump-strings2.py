#!/usr/bin/env python3
"""Dump the candidate string objects found on PlayerNetworking (same live process as bg_4).
No bootstrap needed — addresses are process-stable."""
import ctypes, ctypes.wintypes as w, subprocess

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.OpenProcess.restype = ctypes.c_void_p
kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_uint32]
kernel32.ReadProcessMemory.restype = ctypes.c_bool
kernel32.ReadProcessMemory.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]


def read(h, addr, n):
    buf = ctypes.create_string_buffer(n)
    got = ctypes.c_size_t(0)
    if not kernel32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, n, ctypes.byref(got)):
        return None
    return buf.raw[:got.value]


def i32(b, o): return int.from_bytes(b[o:o + 4], "little", signed=True)
def u64(b, o): return int.from_bytes(b[o:o + 8], "little")


out = subprocess.run(["tasklist", "/fi", "imagename eq Big Walk.exe", "/fo", "csv", "/nh"], capture_output=True, text=True).stdout
pid = int(out.strip().splitlines()[0].split(",")[1].strip('"'))
h = kernel32.OpenProcess(0x143A, False, pid)
print("pid", pid)

targets = {
    "+0xF0 (manifest username)": 0x20abae2c780,
    "+0xF8 (manifest identifier)": 0x20a73e1cd80,
    "+0x100": 0x20a12c5f150,
    "+0x118": 0x20a12b9c2a0,
    "+0x170": 0x205d3fbeb30,
    "+0x180": 0x20a00c42d90,
}
for label, addr in targets.items():
    raw = read(h, addr, 64)
    if raw is None:
        print(f"{label}: unreadable")
        continue
    ln = i32(raw, 0x10)
    chars = raw[0x14:]
    text = chars.split(b"\0\0")[0].decode("utf-16-le", "replace") if len(chars) >= 2 else "?"
    print(f"{label}: len={ln:#x} text={text!r}")
    print(f"    raw head: {raw[:24].hex()}")