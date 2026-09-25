# Big Replay

External replay recorder + viewer for Big Walk (House House / Panic, Unity 6000.3.17f1, IL2CPP).
No mods, no loader: the recorder opens the running game on the host machine with read-only
access, validates an offline field manifest, then samples positions and state entirely via
`ReadProcessMemory`. Produces a replay file that a static web viewer plays back.

## Layout

- `src/Replay.Format/` — replay file model + serializer + static game data (towers, gourd names).
- `src/GameAccess/` — read-only process access, manifest-backed memory readers, game model.
- `src/BigReplay.Recorder/` — CLI + shared capture loop: sample at N Hz, write replay file.
- `src/BigReplay.Desktop/` — native Windows GUI: watch for the game and record automatically.
- `schemas/` — JSON Schema for replay files (the contract the web front-end validates against).
- `index.html`, `map-view.js`, `bigmap.jpeg` — root-level replay viewer and map assets.
- `docs/` — format spec + the read-only/no-writes trust story.

## Status

Work in progress: read-only recorder with an automatic desktop UI + map-backed replay viewer.

## Requirements

- Windows x64. The self-contained desktop release needs no .NET installation.
- .NET SDK 10 to build from source or run the CLI.
- Big Walk (process name `Big Walk.exe`), running as the same user (no admin needed)
- Recorder must run on the **host** machine (Mirror host sees all 12 player bodies + all gourd state)

## Automatic recorder (Windows)

[Download the Big Replay installer](https://github.com/iameli/big-replay/releases/latest/download/BigReplay-Setup.exe)
and run **BigReplay-Setup.exe**. It installs for your Windows account and adds a
**Big Replay** Start menu shortcut. No administrator access or .NET installation is needed.

Select **Start Big Replay when I sign in to Windows** during setup to record
automatically after you sign in. This is optional and unchecked on the first
installation; your selection is remembered on upgrades. It starts the normal
recorder window, not a background service.

To change the setting, close Big Replay and rerun the installer. Unchecking the
option removes startup registration. You can also disable it through Windows
**Settings → Apps → Startup**.

Install updates over the existing installation. Setup will ask you to close a
running Big Replay first so it can finish saving. Uninstall through Windows
**Settings → Apps → Installed apps**; your **Documents/BigReplay** recordings are
kept. Program files live in `%LOCALAPPDATA%\Programs\Big Replay`.

The installer is not code-signed, so Windows may show an unknown-publisher or
SmartScreen warning.

Prefer a portable copy? [Download the Windows x64 ZIP](https://github.com/iameli/big-replay/releases/latest/download/BigReplay-win-x64.zip),
extract it, and run **BigReplay.exe**. Keep the bundled `manifest.json` beside it.
The portable ZIP does not register Windows startup automatically.

- It watches for Big Walk every two seconds, including when launched before the game.
- Once connected, it waits for players and captures at **10 Hz**.
- Replays go into **Documents/BigReplay**, using the Windows Documents location
  (including redirected/OneDrive Documents), with unique timestamped filenames.
- **Pause recording** finishes and saves the current file. **Resume recording**
  starts watching again and creates a fresh recording when the game is available.
- Closing the window finishes and saves; leave it open or minimized during a run.
- **Open recordings folder** opens the output folder in Explorer.
- If the game exits, the replay is finished and the app watches for the next launch.
- When a recorded walk drops to **zero players**, its replay is finished automatically.
  The app waits for players again and records the next walk in a new file, even if
  Big Walk stays open. Losing some players while others remain does not split.
- A missing/incompatible manifest or capture/save failure is shown in the window.
  Fix the problem and click **Resume recording**. Game startup/access failures retry
  automatically. Only one desktop instance runs per Windows login.

Captures use `.replay.json.gz.partial` while recording and become `.replay.json.gz`
only after successful finalization. Do not open the active file in the viewer.
Sessions with no player samples leave no replay. On a capture/save error, any partial
file is retained for investigation; it may not be playable. Forced termination,
Windows shutdown, or power loss can also leave an unfinished file.

**Split boundary:** the first zero-player sample after players have been recorded.
There is no grace period: even a brief observed drop to zero splits the file. The
final zero-player frame and its player-left/run-ended events remain in the old
replay. Waiting in menus before any players appear does not create empty replays.

### Run or package from source

From the repository root:

```powershell
dotnet run --project src/BigReplay.Desktop
```

Build a self-contained Windows x64 release:

```powershell
dotnet publish src/BigReplay.Desktop -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=None -o dist/BigReplay
Compress-Archive -Path dist/BigReplay/* -DestinationPath dist/BigReplay-win-x64.zip -Force
```

To also build `dist/BigReplay-Setup.exe`, install
[Inno Setup 6](https://github.com/jrsoftware/issrc/releases/tag/is-6_7_1) and run after publishing:

```powershell
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" /DAppVersion=0.1.0 installer/BigReplay.iss
```

Distribute the ZIP, not just the executable: the manifest is required. The bundled
manifest must match the installed game build; see [the trust notes](docs/trust.md).

The CLI remains available:

```powershell
dotnet run --project src/BigReplay.Recorder -- record manifest.json --out my-walk.replay.json.gz
```

Ctrl+C, game process exit, or a recorded walk dropping to zero players finishes the
CLI's single output file. Use the desktop app to keep watching and automatically
record subsequent walks. Existing output files are never overwritten.

### Automated releases

Pushes to `next` run [Release Big Replay](https://github.com/iameli/big-replay/actions/workflows/release.yml):
build the solution on Windows with .NET 10, publish the self-contained x64 app, and
attach **BigReplay-Setup.exe** and **BigReplay-win-x64.zip** to a new commit-tagged
GitHub release marked **latest**. The installer is built with the Windows runner's
Inno Setup compiler. The download links above always select that latest release.

The same workflow deploys the viewer to [big-replay.iame.li](https://big-replay.iame.li/)
in a separate GitHub Pages job. It publishes only `index.html`, `map-view.js`,
`bigmap.jpeg`, the synthetic `sample.replay.json.gz`, and `CNAME` at the site root;
other recordings in the repository are not included. Repository Pages settings use
**GitHub Actions** as the build source, with the `github-pages` environment allowing
deployments from `next`.

`CNAME` contains `big-replay.iame.li`. Its DNS CNAME points to `iameli.github.io`,
and GitHub Pages is configured for that custom domain with HTTPS enforced.

New pushes cancel superseded builds; only the current `next` commit is published.
The workflow can also be run manually from the Actions page with `next` selected.
It uses GitHub's built-in token; no separate release secret is required.

## Replay map

Open the **[live Big Replay viewer](https://big-replay.iame.li/)** in a current
Chromium browser and choose or drop a `.replay.json.gz` / `.json` recording.
Chosen files are read locally in your browser, not uploaded.
[Try the bundled sample](https://big-replay.iame.li/?replay=sample.replay.json.gz).
The **Download Big Replay** button in the top-right of the controls opens the latest
release in a new tab without interrupting the viewer.

For offline use, open the root `index.html` from a checkout. Keep `map-view.js` and
`bigmap.jpeg` beside it. No build or package install is needed. Alternatively,
serve the repository root with a static HTTP server and open `/?replay=run1.replay.json.gz`.

Browser-saved calibration and display preferences are per origin; settings from
the former `github.io` site do not automatically transfer to the custom domain.

Drag the map to pan, scroll or pinch to zoom around the cursor, and use **Fit map**
to reset the view. Trackpad pinch has higher sensitivity than ordinary scrolling.
Playback starts paused; the timeline selects exact recorded frames. Playback and
the clock use recorded timestamps rather than assuming uniform samples.

The sidebar groups Playback, Player colors, Tower progress, Map alignment, and
Events into collapsible sections. Click a heading, or focus it and press Enter
or Space, to toggle it. Map alignment starts collapsed; the other sections start open.

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