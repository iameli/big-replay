# Replay storage

## v2: sparse JSON Lines

New captures are UTF-8 `.replay.jsonl`, one JSON object followed by LF per
record. Write the header once, then append frames and events in observation
order. No array to close, count to backpatch, or footer to lose. Example:

```jsonl
{"header":{"formatVersion":2,"gameVersion":"1.6.0","unityVersion":"6000.3","recordedAt":"2026-11-26T10:00:00Z","sampleIntervalSec":0.1,"landmarks":[]}}
{"event":{"time":0,"type":"run-started"}}
{"frame":{"time":0,"monuments":[2,0,{"homeName":100,"filled":false},1,{"homeName":101,"filled":false}]}}
{"frame":{"time":0.1}}
{"frame":{"time":0.2,"monuments":[2,1,{"homeName":101,"filled":true}]}}
{"frame":{"time":0.3,"monuments":[1]}}
```

* Start `players`, `gourds`, and `monuments` as empty arrays. Every sample has
  a `frame` and its actual `time`, even if nothing changed. An omitted array
  means **keep**, not clear. Events do not advance or modify the frame.
* A present array is `[newLength, index, replacement, index, replacement, …]`.
  Keep the previous prefix up to `newLength`; apply whole-object replacements
  at strictly increasing, zero-based indices less than `newLength`. Every new
  slot must be initialized. `[0]` clears; `[n]` alone can truncate. No field
  merging: a player losing its optional name is observable. Retain earlier
  frames unchanged when applying later patches.
* Slots, not names or network IDs, address replacements. Order and duplicate
  identifiers round-trip. Reordering is correct but costs a replacement for
  each changed slot; stable capture order is cheaper. No movement threshold,
  coordinate rounding or periodic resending of stationary objects.
* LF commits a record. A stopped plain file is readable through its last LF;
  discard an unterminated tail even if it looks like JSON. Never skip a corrupt
  **complete** line and apply later deltas to the wrong state. Flushing each
  record does not guarantee the OS has persisted it through power loss.
* With gzip requested, the decompressed bytes are identical in format. Gzip
  finalization matters; do not rely on opening a truncated gzip stream. For
  raw append/recovery keep the capture plain and compress it for transport.

The viewer detects both formats by content after optional gzip decompression.
`scripts/merge-replays.py IN1 IN2 OUT` accepts mixed versions; use
`OUT.replay.jsonl[.gz]` for sparse output or `.json[.gz]` for legacy tools.
To inspect a recording, `head -n 5 walk.replay.jsonl` needs no decoder. Seeking
from an arbitrary byte requires earlier state; this is an append log, not an
indexed archive.

### Why JSON Lines rather than DRISL-CBOR?

Omitting the unchanged objects is independent of the value codec.
[DRISL](https://dasl.ing/drisl.html#format) gives deterministic bytes, but a
single DRISL document is bounded, uses 64-bit floats, disallows indefinite
arrays, and discourages concatenated documents. An append log would need a
framing convention and a binary decoder in each consumer. We don't need
per-frame CIDs. AT Protocol's [record data model](https://atproto.com/specs/data-model)
disallows floats, but that does **not** constrain the replay **blob**.

Size check: 100 samples at 10 Hz, one stationary player, 300 gourd snapshots
in stable order, three X coordinates changed per sample after the first.
The fixture used .NET `Random(93)` positions and no coordinate quantization.
These are synthetic sizes, not estimates for every walk.

| Encoding of the same observations | Bytes |
|---|---:|
| Full v1 JSON, before compression | 2,912,072 |
| Full v1 JSON, gzip fastest with per-frame flush (old capture) | 357,869 |
| Sparse v2 JSON Lines, uncompressed (new capture) | 63,897 |
| Sparse v2 JSON Lines, gzip level 1 after capture | 14,679 |
| Same sparse records as sorted-key CBOR with 64-bit floats and 4-byte record lengths | 50,190 |
| Same length-framed CBOR, gzip level 1 after capture | 12,701 |

The binary rows measure an alternative **container**, not a single DRISL
document. Here the binary codec saved another 13.7 KB uncompressed, or 2 KB
after gzip; removing repeated snapshots made the larger difference.

## v1: legacy full snapshots

Existing `.replay.json[.gz]` files contain one JSON document:

```jsonc
{
  "header": {                          // fixed metadata
    "formatVersion": 1,
    "gameVersion": "1.5.1 2608271531",
    "unityVersion": "6000.3.17f1",
    "recordedAt": "2026-09-24T...",
    "sampleIntervalSec": 0.1,
    "landmarks": [{ "id", "label", "x", "y", "z" }]
  },
  "frames": [                          // one per sample, ~10 Hz
    {
      "time": 12.3,                    // seconds since first frame
      "players": [{
        "netId": 123, "x", "y", "z", "yaw",
        "alive", "isPending", "drowsy",
        "carriedGourd": 0              // saveablePropName of carried gourd, 0 = none
      }],
      "gourds": [{
        "name": 100,                   // saveablePropName (100..177 = world gourds)
        "x", "y", "z",
        "state": 0..3,                 // 0 locked, 1 loose, 2 stashed, 3 pinned
        "pinnedAtHome": 0,             // saveableHomeName when pinned at a monument
        "holderNetId": 0               // carrying player when stashed
      }],
      "monuments": [{ "homeName": 100, "filled": true }]
    }
  ],
  "events": [{ "time", "type", "detail" }]
}
```

## Coordinate space

World space (Unity `Vector3`, y-up). The viewer projects X/Z onto `bigmap.jpeg`
using a bundled train-track calibration, a manually aligned full player route, or
three matched world/image references. Saved browser calibration takes precedence
over the bundled default. Y is height and is not used for this top-down projection.
Header landmarks can provide reference coordinates, but may be empty; player and
gourd positions can also be used for three-point alignment.

Image coordinates are native 4096 × 4096 pixels: origin at top-left, U right,
V down. The calibrated affine transform is:

```text
u = xx * x + xz * z + tx
v = yx * x + yz * z + ty
```

Pan, zoom, viewport fitting, and device-pixel ratio are separate rendering
operations; none changes the world-to-image calibration. Full-route editing uses
all finite recorded player X/Z positions, independently of the playback frame.
Translation, rotation, scaling, reflection, stretch, and shear modify an unsaved
preview; **Lock alignment** commits it and **Cancel** restores the prior alignment.
The locked transform and reference points are stored in browser local storage,
not in the replay format. See the README for alignment steps and accuracy limits.

## Event types

- `run-started` / `run-ended` — recording start and Mirror server active transitions
  (host lobby open/close); `run-ended` also marks the first zero-player frame after
  players were recorded, which finishes that replay.
- `player-joined` / `player-left` — netId set changes
- `death` — corpse count increase
- `gourd-pinned` — a monument slot becomes filled (detail = saveableHomeName)
- `tower-filled` — all slots of a tower group filled (detail = tower key)

## Shared replays (atproto)

Published replays are `com.iameli.bigWalk.replay` records
(`lexicons/com/iameli/bigWalk/replay.json`). The `replay` blob is gzip data;
`format` distinguishes `com.iameli.bigWalk.replay#jsonGzV1` (legacy document)
from `com.iameli.bigWalk.replay#jsonlGzV2` (sparse lines). The record carries
browsable metadata only (title, description, recordedAt, integer `durationMs`,
gameVersion, players, stats); atproto records cannot hold floats, so positions
stay in the blob. Each player entry keeps the recorded Steam `name` and an
optional owner-chosen `nickname`, keyed by `netId`. A new blob encoding gets a
new `format` token rather than a new collection.

## Live stream

The recorder's WebSocket stays at protocol 1: one full snapshot per frame, not
disk deltas. Envelopes are JSON objects terminated by `\n`.

```text
{"hello":{"protocol":1,"session":"<guid>","app":"Big Replay","startedAt":"…","sampleIntervalSec":0.1,"gameVersion":"…","unityVersion":"…","backlogFrames":0}}
{"header":{ …v1 header… }}
{"frame":{ …full v1 frame… }}
{"events":[ …zero or more events appended since the previous line… ]}
{"bye":{"reason":"run-ended"}}
```

Rules a client can rely on:

- A connection always begins with the run's `hello`, then its `header`, then every
  `frame` and `events` line recorded so far, in publish order; live lines follow on
  the same socket. A client therefore has the full run and can start wherever it
  likes — the viewer opens at the live point and rewinds from there.
- `hello.backlogFrames` says how many `frame` lines this connection is about to
  receive before it reaches the live point, so a client can wait for the whole
  history instead of guessing from whatever arrives first.
- `session` identifies one recording run. A new run on the same socket (the desktop
  app records the next walk automatically) sends a new `hello` and starts over.
- `header` is sent once per run, when the first frame with players is captured, and
  carries the landmarks known at that moment — the same ones the file header holds.
- `time` is seconds from the start of the run and only ever increases, so a client
  can drop a duplicate line after a reconnect.
- `bye` ends a run (`run-ended`, `stopped`, `game-exited`, `capture-failed`) without
  closing the socket; the next run sends a new hello.
- Frames use the same snapshot fields (camelCase, nulls omitted). Disk v2 does
  not reduce the live server's full-history memory or network usage. Use
  `--no-live` if only the recording is needed.

The viewer's client (`live-client.js`) buffers a session and feeds the normal replay
pipeline, and `docs/trust.md` covers what the stream does and does not touch.

The same port also answers plain `GET` requests with the viewer bundled inside the app
(`http://127.0.0.1:8787/`), so a browser can open the page and connect to the stream
from one origin. Unknown paths answer `404` with that hint.

## Schema

`schemas/replay-v1.schema.json` describes a legacy document;
`schemas/replay-v2.schema.json` describes one v2 line. Ordering and patch
invariants also require the preceding records. Bump `formatVersion` for
breaking disk changes, independently of the live protocol version.