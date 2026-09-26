#!/usr/bin/env python3
"""Merge two BigReplay v1 replays (two segments of the same run) into one.

Splices the second segment directly after the first on the recording
timeline and rebases the whole thing to t=0. Handles the crash artifact
of old recorder builds (a stray "," before the closing "]" of the frames
array) and drops the second file's artificial re-attach events (its
run-started and the player-joined burst for players already present).

Usage:
    py scripts/merge-replays.py IN1 IN2 OUT
"""
import gzip
import json
import sys


def load(path):
    """Decompress (tolerating truncation) and parse a replay, repairing the
    old writer's "," -before-"]" crash artifact."""
    with gzip.open(path, "rb") as f:
        raw = f.read()
    text = raw.decode("utf-8", errors="replace")
    repaired = False
    if '},],"events"' in text:  # WriteFrame died after "," but before the frame
        text = text.replace('},],"events"', '}],"events"')
        repaired = True
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        # truncation: keep the longest complete prefix up to the last closing }
        cut = text.rfind("\n")
        while cut > 0:
            try:
                data = json.loads(text[:cut])
                repaired = True
                break
            except json.JSONDecodeError:
                cut = text.rfind("\n", 0, cut)
        else:
            raise
    data.setdefault("frames", [])
    data.setdefault("events", [])
    return data, repaired


def write(out_path, header, frames, events):
    with gzip.open(out_path, "wt", encoding="utf-8", compresslevel=6) as f:
        json.dump({"header": header, "frames": frames, "events": events}, f, separators=(",", ":"), ensure_ascii=False)


def main():
    in1, in2, out = sys.argv[1], sys.argv[2], sys.argv[3]
    a, rep1 = load(in1)
    b, rep2 = load(in2)
    h1, h2 = a["header"], b["header"]
    for k in ("formatVersion", "gameVersion", "unityVersion", "sampleIntervalSec"):
        if h1.get(k) != h2.get(k):
            sys.exit(f"segment mismatch on {k}: {h1.get(k)!r} vs {h2.get(k)!r} — not the same run/build")
    if h1["recordedAt"] > h2["recordedAt"]:
        sys.exit("segments appear in the wrong order (first file attached later)")

    fa, fb = a["frames"], b["frames"]
    interval = h1["sampleIntervalSec"]

    # timeline: rebase file1 to 0, splice file2 right after file1's last frame
    shift_a = -fa[0]["time"]
    seam = fa[-1]["time"] + interval
    shift_b = seam - fb[0]["time"]

    frames = []
    for fr in fa:
        fr = dict(fr)
        fr["time"] += shift_a
        frames.append(fr)
    for fr in fb:
        fr = dict(fr)
        fr["time"] += shift_b
        frames.append(fr)
    assert all(frames[i]["time"] < frames[i + 1]["time"] for i in range(len(frames) - 1)), "merged times not monotonic"

    # events: keep file1's; rebase. For file2, drop the artificial re-attach burst
    # (run-started + joins of players already present in file1's final cast) and
    # rebase the rest. Mark the seam with a recorder-resumed event.
    last_cast = {p["netId"] for p in fa[-1]["players"]}
    events = [dict(e) | {"time": e["time"] + shift_a} for e in a["events"]]
    for e in b["events"]:
        t0 = e["time"]
        if t0 < 1.0:
            if e["type"] == "run-started":
                continue
            if e["type"] == "player-joined" and int(e["detail"]) in last_cast:
                continue
        events.append(dict(e) | {"time": t0 + shift_b})
    events.append({"time": seam, "type": "recorder-resumed",
                   "detail": "recording restarted mid-run; segments spliced"})
    events.sort(key=lambda e: e["time"])

    import datetime as _dt
    t1 = _dt.datetime.fromisoformat(h1["recordedAt"].replace("Z", "+00:00"))
    t2 = _dt.datetime.fromisoformat(h2["recordedAt"].replace("Z", "+00:00"))
    untracked = (t2 - t1).total_seconds() - (fa[-1]["time"] - fa[0]["time"])
    print(f"in1 {in1}  frames={len(fa)}  t={fa[0]['time']:.2f}->{fa[-1]['time']:.2f}"
          f"  players={fa[0].get('players') and len(fa[0]['players'])}->{len(fa[-1]['players'])}"
          f"  gourds={len(fa[-1]['gourds'])}")
    print(f"in2 {in2}  frames={len(fb)}  t={fb[0]['time']:.2f}->{fb[-1]['time']:.2f}"
          f"  players={len(fb[0]['players'])}->{len(fb[-1]['players'])}"
          f"  gourds={len(fb[0]['gourds'])}->{len(fb[-1]['gourds'])}")
    print(f"merged {out}  frames={len(frames)}  duration={frames[-1]['time'] - frames[0]['time']:.1f}s"
          f"  seam t={seam:.2f}  events={len(events)}")
    if untracked > 0:
        print(f"[note] untracked wall time between segments ~= {untracked:.0f}s"
              f" (file2 attachment minus file1 recorded span)")
    if rep1:
        print("[note] in1 repaired stray comma (old-writer crash artifact)")
    if rep2:
        print("[note] in2 repaired stray comma")


if __name__ == "__main__":
    main()