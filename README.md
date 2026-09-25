# Big Walk Replay

External replay recorder + viewer for Big Walk (House House / Panic, Unity 6000.3.17f1, IL2CPP).
No mods, no loader: the recorder attaches to the running game on the host machine, resolves the
game's own metadata once at attach (read-only il2cpp API calls), then samples positions and
state entirely via `ReadProcessMemory`. Produces a replay file that a static web viewer plays back.

## Layout

- `src/Replay.Format/` — replay file model + serializer + static game data (towers, gourd names).
- `src/GameAccess/` — process attach, one-shot metadata resolver, memory readers, game model.
- `src/BigWalkReplay.Recorder/` — CLI: attach, sample at N Hz, write replay file.
- `schemas/` — JSON Schema for replay files (the contract the web front-end validates against).
- `web/viewer/` — static replay viewer with the island image, playback, and map calibration.
- `docs/` — format spec + the read-only/no-writes trust story.

## Status

Work in progress: attach-time resolver + recorder spine + map-backed replay viewer.

## Requirements

- Windows x64, .NET SDK 10
- Big Walk running (process name `Big Walk.exe`), same user (no admin needed)
- Recorder must run on the **host** machine (Mirror host sees all 12 player bodies + all gourd state)

## Replay map

Open `web/viewer/index.html` in a current Chromium browser and choose or drop a
`.replay.json.gz` / `.json` replay. `bigmap.jpeg` is loaded from the repository root;
keep that relative layout intact. No build or package install is needed.
Alternatively, serve the **repository root** with a static HTTP server and open
`/web/viewer/index.html?replay=../../run1.replay.json.gz`.

Drag the map to pan, scroll to zoom around the cursor, and use **Fit map** to reset
the view. Playback starts paused; the timeline selects exact recorded frames.
Playback and the clock use recorded timestamps rather than assuming uniform samples.

### Aligning world coordinates

The JPEG has no georeferencing metadata, and the current real captures have empty
landmark lists. The viewer deliberately does **not** stretch replay bounds over
the image or show guessed marker positions.

1. Scrub to a position you recognize on the map. Under **Map alignment**, select
   the player, a recorded landmark, or a gourd at that frame.
2. Click **Place reference**, then click the matching location in the image.
   Placement pauses playback and freezes that reference's world coordinates.
   You can still pan and zoom before clicking.
3. Repeat for three widely separated locations forming a triangle. A single
   player at three different times works; do not use three points on a straight path.
4. Once aligned, check a **fourth** known location. Three points fit exactly and
   cannot establish accuracy by themselves. Use **Undo** or **Clear** to replace
   incorrect references.

Calibration supports rotation, axis reversal, independent scale, and shear.
Players, trails, gourds, and landmarks all use the same world → image → screen
transform. Hovering reports image pixels and, once calibrated, world X/Z.
The map is top-down: Y/height is not projected.

References persist in browser local storage and apply to other replays using the
same game world and this map image. They do not modify the replay. Storage may be
unavailable in private/file contexts; the UI reports a failed save. Keep the same
origin when serving over HTTP. No geographically verified default calibration is
bundled yet.

Current real captures contain only 0/π yaw values, so the viewer omits facing
arrows rather than presenting them as reliable headings.