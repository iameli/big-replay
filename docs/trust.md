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
- **No network.** The recorder writes a local replay file only.

The one process-level interaction is opening a handle with read access — the same access any
memory probe takes. Pure reads cannot change game state.

## Scope

- Fixes the recorder to the game build pinned in the manifest (Big Walk 1.5.1,
  Steam buildid 24982892). After a Big Walk update, regenerate the manifest with
  `ManifestGen` (one command) and ship the new `manifest.json` with the recorder.
- The recorder must run on the **host** machine during a lobby; the host is the only
  side that sees all 12 player bodies and all gourd state.

## Prior art

The game's own speedrunning community already uses LiveSplit autosplitters for Big Walk
(`LiveSplit-ASL/BigWalk.asl`) that read the same memory. This tool is the same class of
read-only monitoring, packaged for replays.