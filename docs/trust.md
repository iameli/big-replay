# Trust: what this tool does (and doesn't) do

The recorder is designed so speedrunners can run it without worrying about game integrity:

## What it does

1. **Offline, before the run** (`ManifestGen`): reads the game's files
   (`GameAssembly.dll`, `global-metadata.dat`) and produces a small manifest of field
   offsets. Nothing here touches a running game.
2. **At attach** (recorder start): opens the game process with read-only access rights
   (`PROCESS_VM_READ | PROCESS_QUERY_INFORMATION`) and validates the running build matches the
   manifest (compares the loaded module's PE header).
3. **During the run**: reads memory only, via `ReadProcessMemory`. Every value — players,
   gourds, monuments — is obtained by reading addresses resolved from the game's own metadata.

## What it never does

- **No writes** to the game process. There is no `WriteProcessMemory` call in the recorder.
- **No code execution** in the game. No `CreateRemoteThread`, no injected threads, no DLLs,
  no loader, no hooks, no debugger.
- **No allocs** in the game. `VirtualAllocEx` is never called.
- **No game file modifications.** The game folder and profile stay untouched.
- **No outbound network.** The recorder never connects to anything. Sharing happens
  separately in the web viewer, and only when you sign in and choose **Share**.

The one process-level interaction is opening a handle with read access — the same access any
memory probe takes. Pure reads cannot change game state.

## Live streaming (the one listening socket)

The desktop app and `record --live-port` serve the captured frames over a local
WebSocket so people can watch a walk as it happens:

- It **listens**; it never dials out. Default bind is loopback
  (`ws://127.0.0.1:8787/`), so only programs on your own machine can connect.
- The same port serves the viewer itself (`http://127.0.0.1:8787/`) — static files
  bundled into the app, no data, no telemetry, no outbound requests of its own.
- What leaves is only replay data you already have on disk: player positions, gourd
  and monument state, names as recorded. It is the same JSON a `.replay.json.gz`
  holds, sent as plain lines (no compression, no encryption — treat it like the
  recording itself).
- A viewer elsewhere on your LAN must be opted in with `--live-bind` (for example
  `--live-bind 0.0.0.0`); that will prompt Windows Firewall and lets anyone who can
  reach the port watch. `--no-live` turns the server off entirely.
- The stream is read-only in both directions: viewers cannot change anything, and no
  client input reaches the game or the recorder.
- It does not touch the game process at all — the capture loop is unchanged, and the
  server only receives copies of frames the recorder already produced.

## Scope

- Fixes the recorder to the game build pinned in the manifest (Big Walk 1.5.1,
  Steam buildid 24982892). After a Big Walk update, regenerate the manifest with
  `ManifestGen` (one command) and ship the new `manifest.json` with the recorder.
- Any player in the lobby can run the recorder: player, gourd and monument state is replicated
  to every client, so the capture does not have to come from the host.

## Prior art

The game's own speedrunning community already uses LiveSplit autosplitters for Big Walk
(`LiveSplit-ASL/BigWalk.asl`) that read the same memory. This tool is the same class of
read-only monitoring, packaged for replays.