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

World space (Unity `Vector3`, y-up). The viewer projects a top-down (x, z) view and uses the
header landmarks (monument homes + gourd vices) as the schematic map.

## Event types

- `run-started` / `run-ended` — Mirror server active transitions (host lobby open/close)
- `player-joined` / `player-left` — netId set changes
- `death` — corpse count increase
- `gourd-pinned` — a monument slot becomes filled (detail = saveableHomeName)
- `tower-filled` — all slots of a tower group filled (detail = tower key)

## Schema

`schemas/replay-v1.schema.json` is the contract the web viewer validates against.
Bump `formatVersion` on any breaking change.