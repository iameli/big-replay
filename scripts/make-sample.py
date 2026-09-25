#!/usr/bin/env python3
"""Generate a small synthetic replay for viewer smoke testing (not game data)."""
import gzip, json, math

landmarks = []
for hn in [100, 101, 102, 103, 104, 110, 120, 130, 140, 150, 160]:
    landmarks.append({"id": f"home-{hn}", "label": f"Home {hn}",
                      "x": 5 * (hn % 5), "y": 1.0, "z": -3 * (hn // 10)})
landmarks.append({"id": "gourd-vice-0", "label": "Gourd vice", "x": 2.0, "y": 1.0, "z": 2.0})

frames = []
for i in range(121):
    t = i * 0.5
    players = []
    for slot, (bx, bz, vy, amp) in enumerate([(0, 0, 0.9, 3), (5, 2, 1.2, 4), (10, 1, 0.6, 5)], start=0):
        a = t * vy
        netid = 100 + slot
        players.append({
            "netId": netid,
            "x": round(bx + math.cos(a) * amp * 2, 2),
            "y": 1.0,
            "z": round(bz + math.sin(a) * amp, 2),
            "yaw": round(a % (2 * math.pi), 3),
            "alive": True,
            "isPending": i < 3,
            "drowsy": slot == 2 and i > 40,
            "carriedGourd": 104 if slot == 1 else 0,
        })
    gourds = []
    for g in range(6):
        st = 3 if g < i // 15 else (2 if g == 1 and i > 10 else 1)
        gourds.append({
            "name": 100 + g, "x": round(1 + g * 1.5, 2), "y": 1.0, "z": 4.0,
            "state": st, "pinnedAtHome": 100 + g if st == 3 else 0, "holderNetId": 0,
        })
    monuments = [
        {"homeName": 100 + g, "filled": g < i // 15} for g in range(5)
    ]
    frames.append({"time": round(t, 2), "players": players, "gourds": gourds, "monuments": monuments})

events = [
    {"time": 0.0, "type": "run-started"},
    {"time": 5.0, "type": "player-joined", "detail": "100"},
    {"time": 12.5, "type": "gourd-pinned", "detail": "100"},
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
print("wrote", out, sum(len(f["players"]) for f in frames), "player-samples")