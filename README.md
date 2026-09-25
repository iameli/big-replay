# Big Walk Replay

External replay recorder + viewer for Big Walk (House House / Panic, Unity 6000.3.17f1, IL2CPP).
No mods, no loader: the recorder opens the running game on the host machine with read-only
access, validates an offline field manifest, then samples positions and state entirely via
`ReadProcessMemory`. Produces a replay file that a static web viewer plays back.

## Layout

- `src/Replay.Format/` — replay file model + serializer + static game data (towers, gourd names).
- `src/GameAccess/` — read-only process access, manifest-backed memory readers, game model.
- `src/BigWalkReplay.Recorder/` — CLI + shared capture loop: sample at N Hz, write replay file.
- `src/BigWalkReplay.Desktop/` — native Windows GUI: watch for the game and record automatically.
- `schemas/` — JSON Schema for replay files (the contract the web front-end validates against).
- `web/viewer/` — static replay viewer with the island image, playback, and map calibration.
- `docs/` — format spec + the read-only/no-writes trust story.

## Status

Work in progress: read-only recorder with an automatic desktop UI + map-backed replay viewer.

## Requirements

- Windows x64. The self-contained desktop release needs no .NET installation.
- .NET SDK 10 to build from source or run the CLI.
- Big Walk (process name `Big Walk.exe`), running as the same user (no admin needed)
- Recorder must run on the **host** machine (Mirror host sees all 12 player bodies + all gourd state)

## Automatic recorder (Windows)

Extract the desktop release and double-click **BigReplay.exe**. Keep the bundled
`manifest.json` beside it. No console or command-line arguments are needed.

- It watches for Big Walk every two seconds, including when launched before the game.
- Once connected, it waits for players and captures at **10 Hz**.
- Replays go into **Documents/BigReplay**, using the Windows Documents location
  (including redirected/OneDrive Documents), with unique timestamped filenames.
- **Pause recording** finishes and saves the current file. **Resume recording**
  starts watching again and creates a fresh recording when the game is available.
- Closing the window finishes and saves; leave it open or minimized during a run.
- **Open recordings folder** opens the output folder in Explorer.
- If the game exits, the replay is finished and the app watches for the next launch.
- A missing/incompatible manifest or capture/save failure is shown in the window.
  Fix the problem and click **Resume recording**. Game startup/access failures retry
  automatically. Only one desktop instance runs per Windows login.

Captures use `.replay.json.gz.partial` while recording and become `.replay.json.gz`
only after successful finalization. Do not open the active file in the viewer.
Sessions with no player samples leave no replay. On a capture/save error, any partial
file is retained for investigation; it may not be playable. Forced termination,
Windows shutdown, or power loss can also leave an unfinished file.

**Current boundary:** one file per game process attachment (or Pause/Resume).
Ending a walk and starting another **without closing Big Walk** still uses the same
file. In-process walk/session splitting is intentionally deferred.

### Run or package from source

From the repository root:

```powershell
dotnet run --project src/BigWalkReplay.Desktop
```

Build a self-contained Windows x64 release:

```powershell
dotnet publish src/BigWalkReplay.Desktop -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=None -o dist/BigReplay
Compress-Archive -Path dist/BigReplay/* -DestinationPath dist/BigReplay-win-x64.zip -Force
```

Distribute the ZIP, not just the executable: the manifest is required. The bundled
manifest must match the installed game build; see [the trust notes](docs/trust.md).

The CLI remains available:

```powershell
dotnet run --project src/BigWalkReplay.Recorder -- record manifest.json --out my-walk.replay.json.gz
```

Ctrl+C finishes the replay; game process exit now also finishes it. Existing output
files are never overwritten.

## Replay map

Open `web/viewer/index.html` in a current Chromium browser and choose or drop a
`.replay.json.gz` / `.json` replay. `bigmap.jpeg` is loaded from the repository root;
keep that relative layout intact. No build or package install is needed.
Alternatively, serve the **repository root** with a static HTTP server and open
`/web/viewer/index.html?replay=../../run1.replay.json.gz`.

Drag the map to pan, scroll or pinch to zoom around the cursor, and use **Fit map**
to reset the view. Trackpad pinch has higher sensitivity than ordinary scrolling.
Playback starts paused; the timeline selects exact recorded frames. Playback and
the clock use recorded timestamps rather than assuming uniform samples.

### Markers, trails, and player colors

Players use person-shaped vector icons; gourds use gourd-shaped icons. Larger
markers have light and dark outlines so they remain legible over the terrain.
Carried gourds appear as a small gourd beside the player; sleepy players are labeled.

The **Trails** dropdown offers **Off**, **Recent** (the last 40 frame intervals),
and **Persistent · start to now**. Persistent trails retain each player's history
up to the current replay frame, including players who have left. Scrubbing backward
removes future movement; missing player samples break the line rather than drawing
a jump. The trail mode is remembered in this browser. **Show full player routes**
under alignment is separate: it deliberately includes future positions as well.

**Player colors** lists every player in the recording, even before they join or
after they leave. The 12-color palette is Sky, Coral, Mint, Gold, Violet, Cyan,
Orange, Pink, Lime, Ivory, Rose, and Slate. Players receive distinct initial colors
for a 12-player recording. Selecting another player's color swaps their assignments.
Icons, labels, history trails, and full routes outside alignment mode all use the
same player color.

Color choices are stored in this browser by netId, not runner identity. Reassign
them with the dropdowns when roles or player IDs change between recordings.
These display preferences do not modify replay files.

### Aligning world coordinates

The viewer ships a default calibration manually aligned to the full train circuit
on `bigmap.jpeg`, so replay markers appear immediately. Saved browser calibrations
take precedence. You can refine the alignment or clear it to start from scratch;
the viewer never treats replay bounds as a geographic calibration.

#### Align a full route (for example, the train circuit)

1. Load the recording and click **Adjust full route** (or **Align full route** if
   calibration was cleared). A pink overlay shows every recorded player position
   across the entire replay, independent of the timeline. It starts from the
   current alignment; without one, its initial position is only a starting preview.
2. **Drag** anywhere on the map to slide the route. **Shift-drag** pans the map;
   scrolling zooms the view without changing the alignment.
3. Adjust **Scale %** and **Rotate °** with the sliders or numeric fields.
   Rotation has 0.1° precision and pivots around the route center. The offset fields
   allow fine positioning in image pixels. Flip horizontal/vertical if needed.
4. Under **Fine adjustment**, width, height, and shear can correct differences
   that uniform scaling and rotation cannot. Check widely separated track bends
   rather than fitting just one short section.
5. Click **Lock alignment** to save the transform in this browser and restore
   normal replay markers. **Cancel** discards the preview and restores the prior
   alignment. **Adjust full route** reopens the saved alignment for refinement;
   its controls start at neutral values relative to that alignment.

**Show full player routes** keeps the entire route visible outside editing.
During editing, current-frame markers are hidden so the track stays readable.
The route includes all players; a single-player train recording is the clearest
reference. Neither locking nor editing changes the recording.

#### Alternatively, match three known positions

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

The locked transform and any reference points persist in browser local storage
and apply to other replays using the same game world and this map image. Existing
three-reference calibrations remain supported. They do not modify the replay. Storage may be
unavailable in private/file contexts; the UI reports a failed save. Keep the same
origin when serving over HTTP. Missing or corrupt saved calibration falls back to
the bundled train-track alignment. **Clear** deliberately keeps the viewer
uncalibrated, including after reload, so you can place new references.

Current real captures contain only 0/π yaw values, so the viewer omits facing
arrows rather than presenting them as reliable headings.