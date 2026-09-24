# Big Walk Replay — Plan & Handoff

Status: **working end-to-end, verified live.** A no-mod recorder captures Big Walk runs
externally and a web viewer plays them back. This file orients the next agent: where we are,
how the machinery works, and what a full-featured replay editor should be.

## Goal

For the 12-person routing group: after a hosted run, a replay file shows everyone's locations
and status (backpacks, carried gourds, drowsiness) plus all gourd state and monument slots.
Crucially: **no mods, no writes to the game** — speedrunners must be able to trust it. The
recorder attaches to the host's running game and is 100% `ReadProcessMemory` from attach to exit.

## What works today (live-verified 2026-09-24)

- `ManifestGen` (offline, from game files) — per-class instance field offsets, ordered static
  lists with aligned block offsets, type indices, image/namespace. Validated against the
  BigWalk.asl ground truth (mover 0x90, onPin 0x40, `<netIdentity>` 0x40, `<isLocalPlayer>` 0x22).
- `Recorder` (`probe` / `probe-ro` / `record`) — pure reads; resolves static blocks at attach
  via klass discovery (below), samples players/gourds/corpses/monuments at N Hz, writes
  gzip-JSON replay files with events.
- `web/viewer/index.html` — single-file viewer: top-down XZ map, markers (players w/ yaw +
  carried-gourd + drowsy, gourds colored by state, monument slots, landmarks), timeline scrub,
  play/pause/1x–8x, per-player trails, tower fill table, event list with click-to-seek,
  loads via drag-drop or `?replay=<url>`.
- Verified session: `record -d 40` produced `my-walk.replay.json.gz` — 367 frames,
  `players 1/1`, **45 gourds**, player netId 579 at (569.5, 30.5, -550.9); viewer playback
  ran with zero console errors.

## Architecture (read this before changing anything)

```
game files (GameAssembly.dll, global-metadata.dat)
   │  offline
   ▼
ManifestGen ──► manifest.json        # per-build fingerprint + field layout
                   │
game process ──attach (read-only)──► GameProcess      # OpenProcess(VM_READ|QUERY) + RPR
                   │
                   ▼
               GameLayout ──► ClassDiscoveryContext    # klass → static blocks (pure reads)
                   │
                   ▼
               GameStateReader ──► ReplayWriter ──► *.replay.json.gz ──► web/viewer
```

### The il2cpp v39 facts that everything rests on (engine headers, Unity 6000.3.17f1)

- `Il2CppClass` (x64): `name @ +0x10`, `image @ +0x00`, `static_fields @ +0xB8`,
  `fields @ +0x80`, self-pointer ("klass", points to itself) @ +0x78.
  Verified from `Editor\Data\il2cpp\libil2cpp\il2cpp-class-internals.h` AND the game's own
  export stubs (`il2cpp_class_get_static_field_data` = `mov rax,[rcx+0xB8]; ret`).
- **`Il2CppType.data` for CLASS/VALUETYPE is a `typeHandle` (metadata-image pointer), never a
  klass pointer** (changed in modern il2cpp). Old tutorials that dereference `type.data` as a
  klass are wrong for this game.
- Klass objects are **heap-allocated lazily** (registered in `s_TypeInfoDefinitionTable`
  per type-definition index). A class has no klass object until something first touches it —
  that is why e.g. `NetworkServer`/`PlayerCharacter` show up only when actually used.
- Static fields: block base = `klass->static_fields`; slot offsets are the **runtime static-block
  layout** (declaration order, natural alignment by size — computed offline in ManifestGen and
  matching Mirror's source order). The instance-field table does NOT tell you static offsets.
- **Pure-read klass discovery** (`ClassDiscoveryContext`): 1) find the class name string in the
  metadata image (scan ±32 MB around the type handle — the strings sit ~17 MB away; a too-small
  window silently fails), 2) scan committed memory for qwords pointing at it, 3) validate the
  candidate (`self @+0x78 == cand`, `static_fields @+0xB8 != 0`). Scanning is windowed around the
  first resolved klass (64 MB), one full-space widen per class (a class that just hasn't been
  created should not burn minutes every retry).
- Performance: first-attach discovery ≈ 1–5 min (first class full pass over a 10 GB game);
  afterwards windowed = seconds. The game's memory can be ~10 GB+; full address-space passes are
  expensive. `VirtualQueryEx` region enumeration is required to skip uncommitted memory
  (naive 1 MB chunk walks allocate like crazy and hang).

### Crash saga (important context — do NOT reintroduce)

- An earlier resolver variant (VirtualAllocEx + CreateRemoteThread shellcode, uhara-style) made
  the game hard-crash ~4/4 times, even when the syscalls were denied before anything executed.
  Community LiveSplit's uhara component is fine in their sessions, but our own attempts died —
  root cause never established. **Decision: the recorder is strictly pure reads.** No
  `VirtualAllocEx`/`WriteProcessMemory`/`CreateRemoteThread` anywhere. Re-test any such idea
  cautiously and only with the user present.
- The crash tests also taught us: the user's "in the game / on the train" was always a real
  in-world state; the class/klass not existing was about *lazy class creation*, not menu-vs-world.

### Repo layout

```
src/BigWalkReplay.ManifestGen/   # offline manifest (vendored MIT LibCpp2IL under LibCpp2IL/)
src/GameAccess/                  # GameProcess (read-only handle), ManifestData/Loader,
                                 #   GameLayout, ClassLayout, ClassDiscoveryContext,
                                 #   MemoryRegions, GameStateReader, UnityInternals
src/BigWalkReplay.Recorder/      # CLI: probe / probe-ro / record (-r rate, -d duration, -o out)
src/Replay.Format/               # schema types + ReplayWriter (gzip JSON) + BigWalkData
src/UharaProbe/                  # NET48 experiment against the genuine uhhara component (unused)
web/viewer/index.html            # the viewer
schemas/replay-v1.schema.json    # contract for the web app
docs/format.md  docs/trust.md    # replay format spec + the no-writes trust story
scripts/                         # diagnostics (chain-diagnose, payoff, hunt-*, validate-statics,
                                 #   make-sample) — throwaway but full of hard-won read recipes
manifest.json                    # generated for build 24982892 (1.5.1 2608271531)
```

### Run it

```powershell
# generate manifest for a pinned game build (one time per build)
dotnet run --project src\BigWalkReplay.ManifestGen -- "C:\Program Files (x86)\Steam\steamapps\common\Big Walk" manifest.json
# probe a running game
dotnet run --project src\BigWalkReplay.Recorder -- probe manifest.json
# record (host machine; Ctrl+C or -d N seconds)
dotnet run --project src\BigWalkReplay.Recorder -- record -d 120 -o run.replay.json.gz manifest.json
# play back: open web\viewer\index.html and drop run.replay.json.gz (or ...?replay=/path.json.gz)
```

Requires .NET SDK 10 (net10.0), Windows, Big Walk running as the same user. Recorder must run
on the **host** (only the host sees all 12 bodies and the gourd state). No admin needed.

## Gaps known today

- **Monuments/landmarks were empty in the verified session** — `PropHome`'s klass was never
  created in that all-items lobby (lazy class creation). In a real route it should appear;
  the recorder resolves it automatically when it does. Needs one real-route session to confirm.
- Same story for `NetworkServer.active` / `NetworkClient.connectState` (lobby detection is
  currently **players > 0**, which works).
- `Saved` gourd-name decoding: replay stores integer `SaveablePropName` (100..177 = gourds);
  no name table is shipped yet (viewer shows ids).
- First-attach latency (~1–5 min full pass). Could be cached: on a later run, the metadata
  strings/klass addresses are process-stable only for the same session — but a *session
  manifest* (klass addresses + blocks from probe) could be saved and, when the process restarts
  with new ASLR, only module-relative parts change. Investigate if attach time matters.
- 12-player validation never happened (all sessions were 1 body). The Practice mod can spawn
  12 bodies solo for testing.

## The full-featured replay editor — target

The current viewer is a _player_. The end-state should feel like a **replay editor** for the
12-person routing group. Below is the wishlist, roughly in priority order.

### Must-do (foundation)
1. **Robust file handling**: load gzip + plain JSON; drag-drop, `?replay=`, and an upload
   path for the future webapp; clear errors for corrupt files; keep the replay schema as the
   contract (`schemas/replay-v1.schema.json`); bump format version on breaking changes.
2. **Timeline tooling**: frame-accurate step, loop region (A-B), time ruler, keyboard
   shortcuts (space, arrows, [,]), speed controls (0.25×–16×), current-time readout.
3. **Entities panel**: searchable/filterable list of players, gourds, monuments; toggle
   visibility per entity/type; click-to-follow; consistent colors (stable per netId/person).
4. **Event layer**: filterable event list with click-to-seek, event badges on the timeline,
   and derived events (route-stage changes) if the recorder adds them.
5. **Annotations**: mark points of interest (bookmarks) with notes; exportable with the replay
   (sidecar JSON so the replay file itself stays append-only).

### Should-do (analysis power)
6. **Paths & heatmaps**: per-player movement trails (existing `trail` toggle is a stub);
   toggleable heatmap of player positions over a time window; gourd-location history.
7. **Overlays**: map image overlay calibrated against recorded landmarks/coordinates
   (record landmark world-positions at session start — monument homes + gourd vices; then a
   screenshot can be aligned), distance ruler, coordinate readout.
8. **Comparison**: side-by-side or overlaid two replays (route halves), or time-offset
   alignment for 12-person routing review. This is the big one for the routing group.
9. **Export**: current frame/summary as PNG; CSV of a time window (players/gourds frames,
   events); maybe a video export via canvas capture.
10. **Names**: player netId → runner handle mapping (import CSV / local mapping stored in
    browser localStorage), used in labels and exports.

### Nice-to-have
11. Multi-run session directories (one file per run, auto-segmented when a new lobby starts).
12. Split/route integration hints: tower-fill progress shown against the known-order route
    (the ASL's tower grouping already lives in `BigWalkData`).
13. Webapp backend (upload/share URLs, run database) — the current viewer must stay fully
    functional offline/file-based so speedrunners can use it without hosting.

### Keep-sacred constraints
- Recorder stays strictly read-only; document any change in `docs/trust.md`.
- Do not commit decompiled game code (`out/`, dumps) — patterns like the offsets above are fine
  as numbers, but no dumped sources.
- The manifest is per-build; a Big Walk update needs `ManifestGen` re-run and the manifest
  committed alongside the recorder.
- Version bump the `[BepInPlugin]`-style fingerprint idea: the recorder should print/build
  fingerprint loudly so a stale manifest is obvious.

## Suggested next steps

1. Get one **real 12-person route session** recorded (or Practice-mod 12 bodies solo) to
   confirm monuments/landmarks + multiple players + gourds placed/pinned transitions.
2. Add gourd/pin event transitions to the recorder if the peck-state reads prove out
   (`PeckSwitch.trackedStateSystem` → `TrackedPeckState.currentPeckContext.compressedState`).
3. Build the editor's foundation (1–5 above) in `web/`, keeping the single-file viewer working.
4. Consider path exports + comparison (6–9) for the routing group's actual review workflow.

Good luck — it's in good shape: the hard part (trustworthy external capture) is done and proven.