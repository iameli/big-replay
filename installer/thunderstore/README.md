# Big Replay — Launcher

Records 12-player Big Walk runs from outside the game and plays them back on a map. To see an example of the output, have a look at our 12-player world record: [https://big-replay.iame.li/did:plc:2zmxikig2sj7gqaezl5gntae/3mwlzuf4ihz2e](https://big-replay.iame.li/did:plc:2zmxikig2sj7gqaezl5gntae/3mwlzuf4ihz2e).

This package **auto-starts the standalone Big Replay recorder** when you launch Big Walk through
a mod manager, and closes it (after saving) when the game exits. Big Replay itself stays a
separate executable: it never patches the game and never writes to it — it reads memory only, allowing you to run unmodded versions of the game for speedrun validity. So you can use this package in two ways:

1. If you don't care about speedrun validity, this will take care of running Big Replay for you automatically.
2. Even if you do, keeping this mod up-to-date is a great way to keep Big Replay up-to-date.

## Install

1. Install this package with your mod manager.
2. Launch Big Walk through the mod manager as usual — **Big Replay opens by itself**.
3. Play. Replays are saved to `Documents\BigReplay\`.
4. Watch them at <https://big-replay.iame.li/>, by dropping a replay file onto the viewer.

## Config

| Entry                     | Default | Meaning                                                |
| ------------------------- | ------- | ------------------------------------------------------ |
| `Launcher / Enabled`      | `true`  | Start Big Replay alongside the game.                   |
| `Launcher / GraceSeconds` | `25`    | Seconds after the game exits before Big Replay closes. |

## Links

- Source, standalone downloads, docs: <https://github.com/iameli/big-replay>
- Replay viewer: <https://big-replay.iame.li/>
