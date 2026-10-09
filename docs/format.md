# Replay format (v1)

A replay is a single gzip-compressed JSON document:

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
(`lexicons/com/iameli/bigWalk/replay.json`). The unchanged `.replay.json.gz` file
is the record's `replay` blob, and `format` names its encoding
(`com.iameli.bigWalk.replay#jsonGzV1` for this v1 format). The record carries
browsable metadata only (title, description, recordedAt, integer `durationMs`,
gameVersion, players, stats); atproto records cannot hold floats, so positions
stay in the blob. Each player entry keeps the recorded Steam `name` and an
optional owner-chosen `nickname`, keyed by `netId`. A new blob encoding gets a
new `format` token rather than a new collection.

## Live stream

While it records, the recorder can serve the same data over a WebSocket as **JSON
Lines**: one JSON object per line, `\n` terminated, using the file's exact shapes.

```text
{"hello":{"protocol":1,"session":"<guid>","app":"Big Replay","startedAt":"…","sampleIntervalSec":0.1,"gameVersion":"…","unityVersion":"…","backlogFrames":0}}
{"header":{ …same as the file header… }}
{"frame":{ …same as a file frame… }}
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
- Frames keep the file's gzip-JSON serializer settings (camelCase, nulls omitted),
  so a live client is a replay client. `protocol` bumps only on a breaking change.

The viewer's client (`live-client.js`) buffers a session and feeds the normal replay
pipeline, and `docs/trust.md` covers what the stream does and does not touch.

The same port also answers plain `GET` requests with the viewer bundled inside the app
(`http://127.0.0.1:8787/`), so a browser can open the page and connect to the stream
from one origin. Unknown paths answer `404` with that hint.

## Schema

`schemas/replay-v1.schema.json` is the contract the web viewer validates against.
Bump `formatVersion` on any breaking change.