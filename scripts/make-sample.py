#!/usr/bin/env python3
"""Generate the bundled sample replay: a full 12-player cast spread over the map with names,
gourd carry/pin transitions, monument fills, and join/spin events. Deterministic."""
import gzip, json, math

NAMES = ["iameli", "wren", "moss", "amber", "tofu", "rune",
         "pixel", "maple", "cedar", "nova", "quill", "juno"]
NET_IDS = list(range(100, 112))

landmarks = []
for hn in [100, 101, 102, 103, 104, 110, 120, 130, 140, 150, 160]:
    landmarks.append({"id": f"home-{hn}", "label": f"Home {hn}",
                      "x": 5 * (hn % 5), "y": 1.0, "z": -3 * (hn // 10)})
landmarks.append({"id": "gourd-vice-0", "label": "Gourd vice", "x": 2.0, "y": 1.0, "z": 2.0})

# per-player orbit parameters (x, z centers, y = walkway elevation, angular speed, radius)
ORBITS = [
    (0.0, 0.0, 1.0, 0.9, 3.0), (5.0, 2.0, 1.2, 1.2, 4.0), (10.0, 1.0, 0.8, 0.6, 5.0),
    (-8.0, -4.0, 1.1, 1.0, 3.5), (-12.0, 5.0, 0.9, 0.7, 4.5), (14.0, -6.0, 1.3, 1.1, 4.0),
    (7.0, -12.0, 1.0, 0.8, 3.0), (-5.0, 10.0, 0.7, 1.3, 5.0), (16.0, 8.0, 1.2, 0.9, 4.0),
    (-15.0, -2.0, 0.8, 1.4, 6.0), (3.0, 14.0, 1.0, 0.5, 4.0), (-9.0, -10.0, 1.1, 0.75, 3.0),
]

frames = []
for i in range(180):  # 90s at 0.5s
    t = i * 0.5
    players = []
    for slot, (cx, cz, y, vy, amp) in enumerate(ORBITS):
        a = t * vy + slot * 0.7
        players.append({
            "netId": NET_IDS[slot],
            "name": NAMES[slot],
            "x": round(cx + math.cos(a) * amp * 2, 2),
            "y": y,
            "z": round(cz + math.sin(a) * amp, 2),
            "yaw": round((a % (2 * math.pi)) * 0 + math.pi if a % 2 > 1 else a % (2 * math.pi), 3),
            "alive": slot != 10 or i < 150,      # cedar gets sleepy, quill "leaves" near the end
            "isPending": i < 2 + slot * 2,       # staggered joins
            "drowsy": slot in (2, 6) and i > 100,
            "carriedGourd": 104 if slot == 1 else (105 if slot == 4 else 0),
        })
    gourds = []
    for g in range(6):
        st = 3 if g < i // 25 else (2 if g in (1, 4) and i > 10 else 1)
        gourds.append({
            "name": 100 + g, "x": round(1 + g * 1.5, 2), "y": 1.0, "z": 4.0,
            "state": st, "pinnedAtHome": 100 + g if st == 3 else 0,
            "holderNetId": NET_IDS[1] if (g == 1 and i > 10 and st == 2) else 0,
        })
    monuments = [{"homeName": 100 + g, "filled": g < i // 25} for g in range(5)]
    frames.append({"time": round(t, 2), "players": players, "gourds": gourds, "monuments": monuments})

events = [
    {"time": 0.0, "type": "run-started"},
] + [{"time": 1.0 + s, "type": "player-joined", "detail": str(NET_IDS[s])} for s in range(1, 12)] + [
    {"time": 25.0, "type": "gourd-pinned", "detail": "100"},
    {"time": 50.0, "type": "gourd-pinned", "detail": "101"},
    {"time": 25.0, "type": "tower-filled", "detail": "Red"},
]

replay = {
    "header": {
        "formatVersion": 1,
        "gameVersion": "synthetic",
        "unityVersion": "synthetic",
        "recordedAt": "2026-09-24T12:00:00Z",
        "sampleIntervalSec": 0.5,
        "landmarks": landmarks,
    },
    "frames": frames,
    "events": events,
}

out = "sample.replay.json.gz"
with gzip.open(out, "wt", encoding="utf-8") as f:
    json.dump(replay, f)
print(f"wrote {out}: {len(frames)} frames x {len(NAMES)} players, {len(events)} events")