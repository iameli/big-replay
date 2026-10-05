# Big Replay — Launcher

Records 12-player Big Walk runs from outside the game and plays them back on a map.

This package **auto-starts the standalone Big Replay recorder** when you launch Big Walk through
a mod manager, and closes it (after saving) when the game exits. Big Replay itself stays a
separate executable: it never patches the game and never writes to it — it reads memory only,
the same class of tool as the community LiveSplit autosplitter.

## Install

1. Install this package with your mod manager (it pulls in `BepInExPack_IL2CPP`).
2. Launch Big Walk through the mod manager as usual — **Big Replay opens by itself**.
3. Play. Replays are saved to `Documents\BigReplay\` on the host's PC.
4. Watch them at <https://big-replay.iame.li/>, or drop a replay file into the viewer.

Run this on the **host's** machine: Mirror's host is the only side that sees all 12 player
bodies and all gourd state.

> ⚠️ **Speedrun validity** — installing anything through a mod manager means the game loads
> mods. For validated runs use the [standalone Big Replay](https://github.com/iameli/big-replay/releases/latest)
> with a vanilla launch. This package is the convenience path for people who don't care about
> that distinction; the recorder it starts is identical.

## How the launcher behaves

- Starts `BigReplay.exe` with `--exit-with-game <game pid>`.
- Big Replay then exits — after finishing and saving the current replay — when the game
  process ends, **including a crash** (this game's shutdown frequently throws, so relying on
  clean shutdown callbacks would leave the recorder orphaned).
- A 25-second grace period covers quick relaunches; a relaunch cancels the shutdown.
- If Big Replay is already running, nothing happens (no duplicate windows).

## Config

| Entry | Default | Meaning |
| --- | --- | --- |
| `Launcher / Enabled` | `true` | Start Big Replay alongside the game. |
| `Launcher / GraceSeconds` | `25` | Seconds after the game exits before Big Replay closes. |

The launcher always runs the payload shipped in this package
(`<profile>/BigReplay/BigReplay.exe`). There is intentionally no executable-path setting:
BepInEx configs get shared between users, and a path entry would let a shared config point the
launcher at an arbitrary program.

## Troubleshooting

**The game crashed on the very first modded launch.** That's BepInEx generating its IL2CPP
interop assemblies (normally a several-minute, seemingly-frozen first launch). If it crashes
instead of finishing, just launch again — generation restarts each run — or copy a working
`BepInEx/interop` folder from another profile. After it succeeds, launches are fast and stable.

**Big Replay didn't open.** Check `BepInEx/config/com.bigwalk.replaylauncher.cfg` (`Enabled`) and `BepInEx/LogOutput.log`
for a `Started Big Replay` line.

## Links

- Source, standalone downloads, docs: <https://github.com/iameli/big-replay>
- Replay viewer: <https://big-replay.iame.li/>
- Trust notes (no writes, no injection, no game modification):
  <https://github.com/iameli/big-replay/blob/next/docs/trust.md>