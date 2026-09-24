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
- `web/viewer/` — single-file static viewer (currently drag-and-drop; the future webapp grows here).
- `docs/` — format spec + the read-only/no-writes trust story.

## Status

Work in progress: attach-time resolver + recorder spine + viewer skeleton.

## Requirements

- Windows x64, .NET SDK 10
- Big Walk running (process name `Big Walk.exe`), same user (no admin needed)
- Recorder must run on the **host** machine (Mirror host sees all 12 player bodies + all gourd state)