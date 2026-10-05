#!/usr/bin/env python3
"""Smoke test --exit-with-game: a dummy watched process (notepad) stands in for the game.
  1) pid mode: kill the dummy -> Big Replay must save and exit after the grace period.
  2) name mode with no game running: Big Replay must stay up (no premature exit)."""
import subprocess, time, sys

exe = r"C:\Users\iameli\code\big-replay\src\BigReplay.Desktop\bin\Release\net10.0-windows\BigReplay.exe"

# --- 1) pid mode ---
dummy = subprocess.Popen(["notepad.exe"])
print(f"[1] dummy pid {dummy.pid}")
app = subprocess.Popen([exe, "--exit-with-game", str(dummy.pid), "--grace", "2"])
time.sleep(4)
print(f"[1] app running before kill: {app.poll() is None}")
if app.poll() is not None:
    sys.exit("FAIL: app exited before the watched process died")
dummy.kill()
exited = None
for i in range(25):
    time.sleep(1)
    if app.poll() is not None:
        exited = i + 1
        break
if exited is None:
    app.kill()
    sys.exit("FAIL: app did not exit after the watched process died")
print(f"[1] PASS: app exited ~{exited}s after the dummy died (grace 2s + poll)")

# --- 2) name mode, no game ---
app2 = subprocess.Popen([exe, "--exit-with-game", "--grace", "2"])
time.sleep(9)
alive = app2.poll() is None
print(f"[2] name mode, no game, still running after 9s: {alive}")
app2.kill()
app2.wait()
if not alive:
    sys.exit("FAIL: app exited even though it never saw a game process")
print("[2] PASS: no premature exit")
print("ALL PASS")