#!/usr/bin/env python3
"""Merge two Big Replay recordings (v1 or v2 segments of the same run) into one.

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
import math
import sys


from replay_sparse import COLLECTIONS, apply_patch, frame_delta


def reject_constant(value):
    raise ValueError(f"invalid JSON constant: {value}")


def valid_time(payload):
    return (isinstance(payload, dict) and type(payload.get("time")) in (int, float)
            and math.isfinite(payload["time"]))


def load_lines(header, stream):
    frames, events = [], []
    previous = {key: [] for key in COLLECTIONS}
    repaired = False
    for number, line in enumerate(stream, 2):
        if not line.endswith(b"\n"):
            repaired = True
            break
        record = json.loads(line.decode("utf-8"), parse_constant=reject_constant)
        if isinstance(record, dict) and record.keys() == {"event"}:
            event = record["event"]
            if (not valid_time(event) or not isinstance(event.get("type"), str)
                    or (event.get("detail") is not None and not isinstance(event["detail"], str))):
                raise ValueError(f"invalid event on line {number}")
            events.append(event)
        elif isinstance(record, dict) and record.keys() == {"frame"}:
            delta = record["frame"]
            if not valid_time(delta) or delta.keys() - {"time", *COLLECTIONS}:
                raise ValueError(f"invalid frame on line {number}")
            frame = {"time": delta["time"]}
            for key, identity in COLLECTIONS.items():
                frame[key] = apply_patch(previous[key], delta[key], identity) if key in delta else previous[key]
            frames.append(frame)
            previous = frame
        else:
            raise ValueError(f"unknown record on line {number}")
    return {"header": header, "frames": frames, "events": events}, repaired


def load(path):
    """Read either encoding by content, including plain stranded v2 .partial files."""
    with open(path, "rb") as file:
        compressed = file.peek(2)[:2] == b"\x1f\x8b"
        with gzip.GzipFile(fileobj=file) if compressed else file as stream:
            first = stream.readline()
            try:
                record = json.loads(first)
            except ValueError:
                record = None  # pretty-printed v1 document or old-writer crash artifact
            if isinstance(record, dict) and record.keys() == {"header"}:
                if record["header"].get("formatVersion") != 2 or not first.endswith(b"\n"):
                    raise ValueError("invalid JSON Lines header")
                return load_lines(record["header"], stream)
            if record is not None and not first.endswith(b"\n"):
                data, repaired = record, False  # compact v1: already parsed the entire file
            else:
                text = (first + stream.read()).decode("utf-8")
                repaired = '},],"events"' in text  # old writer died between delimiter and frame
                if repaired:
                    text = text.replace('},],"events"', '}],"events"')
                data = json.loads(text)
    if data["header"]["formatVersion"] != 1:
        raise ValueError("unsupported replay document version")
    data.setdefault("frames", [])
    data.setdefault("events", [])
    return data, repaired


def sparse_records(header, frames, events):
    yield {"header": dict(header, formatVersion=2)}
    previous = {key: [] for key in COLLECTIONS}
    events = iter(events)
    event = next(events, None)
    for frame in frames:
        while event is not None and event["time"] <= frame["time"]:
            yield {"event": event}
            event = next(events, None)
        yield {"frame": frame_delta(previous, frame)}
        previous = frame
    if event is not None:
        yield {"event": event}
    for event in events:
        yield {"event": event}


def write(out_path, header, frames, events):
    opener = gzip.open if out_path.endswith(".gz") else open
    with opener(out_path, "xt", encoding="utf-8", newline="\n") as f:
        if out_path.removesuffix(".gz").endswith(".jsonl"):
            for record in sparse_records(header, frames, events):
                f.write(json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n")
        else:  # Preserve the historical v1 output for .json[.gz] callers.
            json.dump({"header": dict(header, formatVersion=1), "frames": frames, "events": events},
                      f, separators=(",", ":"), ensure_ascii=False)


def main():
    in1, in2, out = sys.argv[1], sys.argv[2], sys.argv[3]
    a, rep1 = load(in1)
    b, rep2 = load(in2)
    h1, h2 = a["header"], b["header"]
    for k in ("gameVersion", "unityVersion", "sampleIntervalSec"):
        if h1.get(k) != h2.get(k):
            sys.exit(f"segment mismatch on {k}: {h1.get(k)!r} vs {h2.get(k)!r} — not the same run/build")
    if h1["recordedAt"] > h2["recordedAt"]:
        sys.exit("segments appear in the wrong order (first file attached later)")

    fa, fb = a["frames"], b["frames"]
    if not fa or not fb:
        sys.exit("both segments must contain at least one complete frame")
    interval = h1["sampleIntervalSec"]

    # timeline: rebase file1 to 0, splice file2 right after file1's last frame
    shift_a = -fa[0]["time"]
    seam = fa[-1]["time"] + shift_a + interval
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
    write(out, h1, frames, events)

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
        print("[note] in1 recovered an incomplete recording")
    if rep2:
        print("[note] in2 recovered an incomplete recording")


if __name__ == "__main__":
    main()