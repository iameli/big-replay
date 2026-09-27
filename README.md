# <img src="logo.svg" height="40" alt=""> Big Replay

Big Replay is a tool for recording character positions in Big Walk and playing them back afterward. It runs alongside the game and pulls data by scraping memory - it's not a mod and doesn't change anything in the running game. To use it, download BigReplay-Setup.exe from GitHub and start the game. Afterward, your replays will be in a BigReplay folder in Documents.

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
in a separate GitHub Pages job. It publishes the root viewer, map, synthetic
`sample.replay.json.gz`, `CNAME`, and the logo/browser icon assets listed in the
workflow; other recordings in the repository are not included. Repository Pages settings use
**GitHub Actions** as the build source, with the `github-pages` environment allowing
deployments from `next`.

`CNAME` contains `big-replay.iame.li`. Its DNS CNAME points to `iameli.github.io`,
and GitHub Pages is configured for that custom domain with HTTPS enforced.

New pushes cancel superseded builds; only the current `next` commit is published.
The workflow can also be run manually from the Actions page with `next` selected.
It uses GitHub's built-in token; no separate release secret is required.

### Logo and icons

`logo.svg` is the source artwork, used directly in the viewer and this README.
`favicon.ico` contains ten sizes from 16 to 256 pixels and is shared by the browser
fallback, Windows executable/window, installer, Start menu shortcut, and Installed
apps entry. The recorder header and installer wizard also display the logo.
The viewer supplies an SVG favicon, Apple touch icon, 192/512-pixel home-screen
icons through `site.webmanifest`, and a logo for link previews.

Generated icons are checked in; normal builds need no image tools. After changing
`logo.svg`, regenerate them with [ImageMagick 7](https://imagemagick.org/script/download.php#windows)
and Microsoft Edge (or another Chromium browser). Chromium renders the SVG first
so clipping, reused paths, and outlines are preserved in the small raster icons.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/generate-icons.ps1
# Or pass -MagickPath C:\path\to\magick.exe for a portable installation.
# Or pass -BrowserPath "C:\Program Files\Google\Chrome\Application\chrome.exe".
```

This preserves the artwork's proportions and transparent background, adding an
opaque background only for the Apple touch icon and installer sidebar.

## Replay map

Open the **[live Big Replay viewer](https://big-replay.iame.li/)** in a current
Chromium browser and choose or drop a `.replay.json.gz` / `.json` recording.
Chosen files are read locally in your browser, not uploaded.
[Try the bundled sample](https://big-replay.iame.li/?replay=sample.replay.json.gz).
The **Download Big Replay** button in the top-right of the controls opens the latest
release in a new tab without interrupting the viewer.
Click the **Big Replay** title or its info icon to open **About**. Close the dialog
with **Close**, Escape, or a click outside it.

For offline use, open the root `index.html` from a checkout. Keep `map-view.js` and
`bigmap.jpeg` beside it. No build or package install is needed. Alternatively,
serve the repository root with a static HTTP server and open `/?replay=run1.replay.json.gz`.

Browser-saved calibration and display preferences are per origin; settings from
the former `github.io` site do not automatically transfer to the custom domain.

Drag the map to pan, scroll or pinch to zoom around the cursor, and use **Fit map**
to reset the view. Trackpad pinch has higher sensitivity than ordinary scrolling.
Playback starts paused; the timeline selects exact recorded frames. Playback and
the clock use recorded timestamps rather than assuming uniform samples.

The sidebar groups Playback, Player names & colors, Tower progress, Map alignment, and
Events into collapsible sections. Click a heading, or focus it and press Enter
or Space, to toggle it. Map alignment starts collapsed; the other sections start open.

### Markers, trails, and player names

Players use person-shaped vector icons; gourds use the side-view gourd silhouette
in both the map and legend. White inner and dark outer outlines keep them visible
over the terrain. Gourds use their physical colors: red `#c64132` by default and
purple `#8053ac` for SaveablePropName IDs **134, 142, 151, 152, 156, 158, 159**.
This 1.5.1 mapping comes from the seven southernmost gourds in the reference
recording after applying the bundled map alignment (`mapY = yx*x + yz*z + ty`,
increasing southward), not from raw game X/Z coordinates.

Colors are fixed by gourd ID, not recalculated from location or carrying/pinning
state. Carried-gourd icons use the same color as the corresponding world gourd.
Locked gourds remain slightly faded; sleepy players are labeled. Existing replays
need no format changes. Review the ID mapping when supporting a new game build.

The **Trails** dropdown offers **Off**, **Recent** (the last 40 frame intervals),
and **Persistent · start to now**. Persistent trails retain each player's history
up to the current replay frame, including players who have left. Scrubbing backward
removes future movement; missing player samples break the line rather than drawing
a jump. The trail mode is remembered in this browser. **Show full player routes**
under alignment is separate: it deliberately includes future positions as well.

Persistent trails and full routes retain the **0.25 CSS pixel** simplification
bound. Completed blocks are rasterized into 256-device-pixel tiles anchored to the
map at the current zoom, not to the screen. Normal forward playback updates only
tiles affected by new movement or revisions to the current partial block.
Per-player outline/fill masks preserve self-intersections and player overlap
order. Already-colored player tiles are reused when another player moves.
The map and trails are composited into cached scene pixels rather than redrawing
all accumulated history each frame.

Panning translates cached pixels and reuses overlapping tiles, including when
reversing direction. Newly exposed or evicted tiles reconstruct at the current
replay frame; returning tiles also incorporate movement recorded while offscreen.
Padded tiles and a grid-aligned scene prevent seams during fractional-pixel pans.
Tile indexes are built only for retained tiles, not for the entire zoomed map.

Wheel and trackpad-pinch zoom immediately rescale the last canvas image around the
cursor. After **120 ms** without another zoom change, the viewer renders the latest
replay frame sharply at the new scale. Markers, labels, and trail widths temporarily
scale with the preview, then return to their normal screen sizes. Playback time
continues advancing during the gesture. Zooming out can briefly expose empty
margins until the final render fills newly visible areas. Fit map, starting a pan,
resizing/pixel-ratio changes, and loading another replay discard the pending preview.

The map/trail bitmap cache has a **64 MiB RGBA pixel budget**, including its scene,
scratch, and retained tiles. Large viewports use evictable scene tiles instead of
an oversized scene bitmap. Markers and labels use a separate **16 MiB / 256-entry**
sprite cache at the display pixel ratio; oversized labels render uncached rather
than truncating names. These budgets do not include replay/geometry data, the
decoded source map, or browser overhead.

Backward seeks, zoom, resizing or pixel-ratio changes, alignment edits, color
changes, and trail-mode changes rebuild the relevant cached pixels. Cold views,
large jumps into uncached areas, and seeks can still take longer than steady
playback or warm panning. Loading another replay releases the previous bitmaps.
Recorded positions and replay files are unchanged.
Hidden alignment reference controls are not rebuilt on every frame.

Geometry and cache-lifecycle regression checks require Node.js but no packages:
`node --test scripts/map-trails.test.cjs`. They also run before Pages deployment.

**Player names & colors** lists every player in the recording, even before they
join or after they leave. The compact list shows nicknames when assigned, otherwise
the first readable recorded username, including names that become available later
in the recording. Unnamed players fall back to `Player #<netId>`. Original names
and network IDs are visible while editing and available by hovering over list names.

Click **Edit nicknames** to reveal the nickname fields, Reset buttons, and editing
help. Enter a **Nickname**, then press **Enter** or leave the field to save it
locally. **Done** saves the current field and hides the editors again; colors remain
available in the compact list. The editors start hidden each time the viewer opens.
Nicknames appear on the map, in join/leave events, and in alignment source choices.
Use **Reset**, or save an empty field, to restore the recorded name. Existing
calibration-reference captions remain historical descriptions captured when those
references were placed.

Nicknames are matched by the **exact recorded username** when it is unique in the
replay, so they follow that name across recordings even if its network ID changes.
Recordings do not contain persistent account IDs: a changed username needs a new
nickname, and matching a display name is not verified account identity. Duplicate
or unnamed players instead have independent nicknames scoped to the recording's
start timestamp and network ID. Older files without that timestamp use a file
hash, so their nicknames persist for the same file without leaking to unrelated
unnamed players.

Nicknames are stored only in this browser, not uploaded or written into replay
files or shared links. If browser storage is unavailable, changes work for the
current session and the settings show a warning.

The 12-color palette is Sky, Coral, Mint, Gold, Violet, Cyan,
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