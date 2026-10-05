# Handoff — Big Replay launcher, Thunderstore packaging, and the interop crash (Oct 2026)

This supersedes `PLAN.md` for *current* state. Read this first; `PLAN.md` is the older
recorder-era plan (its host-only claims have been corrected).

Repos in play:

| Repo | Local path (this machine) | GitHub | Role |
| --- | --- | --- | --- |
| `big-replay` | `C:\Users\iameli\code\big-replay` | `iameli/big-replay` | Recorder, desktop app, viewer, packaging |
| mods repo | `C:\Users\iameli\code\big-walk-speedrun-tools` | **`iameli/big-walk-practice`** | BepInEx plugins incl. `mods/BigWalk.ReplayLauncher` |

Note the name mismatch: the local dir is `big-walk-speedrun-tools`, the GitHub repo is
`big-walk-practice`. CI and the packaging script depend on this.

## 1. What this session delivered

1. **Launcher plugin** — `mods/BigWalk.ReplayLauncher` (mods repo). Launcher-only BepInEx plugin:
   no patches, no game reads. On load it resolves `<profile>/BigReplay/BigReplay.exe` and starts
   it with `--exit-with-game <game pid> --grace <N>`. Config surface is deliberately tiny:
   `Enabled` (bool) and `GraceSeconds` (int 0–600, default 25). **There is intentionally no
   executable-path setting** — Thunderstore reviewer (Harb) flagged that shared config codes
   would otherwise let someone point the launcher at an arbitrary program.
2. **Desktop app support for that** — `src/BigReplay.Desktop`: `--exit-with-game [pid] [--grace N]`.
   Watches the game (by pid when given, else by `Big Walk` process name), and when it exits —
   including the crash path — finishes and saves the current replay, waits out the grace period
   (a relaunch during it cancels the shutdown), then closes via the normal
   `OnFormClosing` save path. Existing single-instance mutex: `Local\BigReplay.Desktop`.
3. **Thunderstore packaging** — `scripts/package-thunderstore.ps1` builds
   `dist/iameli-Big_Replay-<version>.zip`:
   ```
   manifest.json  icon.png  README.md  CHANGELOG.md  LICENSE
   BepInEx/plugins/BigWalk.ReplayLauncher.dll
   BigReplay/{BigReplay.exe, manifest.json, BigReplay.Recorder.runtimeconfig.json}
   ```
   Package metadata: name `Big_Replay` (renders as "Big Replay"), deps
   `BepInEx-BepInExPack_IL2CPP-6.0.755`, author/team `iameli`, version from the Desktop csproj.
   Package assets live in `installer/thunderstore/` (README + CHANGELOG).
4. **CI packaging** — `.github/workflows/release.yml` (push to `next`) now also builds the
   package and attaches it to the GitHub release next to `BigReplay-Setup.exe` and
   `BigReplay-win-x64.zip`. It checks out `iameli/big-walk-practice@main` into `mods-repo`,
   downloads `build-refs.zip` from that repo's `practice-canary` release, builds the launcher
   with `/p:GamePath=$GITHUB_WORKSPACE/ci-refs`, runs the packaging script, then uploads.
   **This path has not executed yet — watch the first CI run.**
5. **Docs/site corrections** — all host-only claims removed (any player in the lobby can record;
   state is replicated to every client): `README.md`, `docs/trust.md`, `PLAN.md`,
   `RecorderForm` hint text, CLI doc comment, release notes, launcher README.
6. **MIT LICENSE** — repo root + inside the package; current package version **0.1.3**.

## 2. Commands cheat-sheet

```powershell
# launcher plugin (mods repo; needs BepInEx core+interop under <profile>)
dotnet build mods/BigWalk.ReplayLauncher/BigWalk.ReplayLauncher.csproj -c Release `
  "/p:GamePath=C:\Users\iameli\AppData\Roaming\r2modmanPlus-local\BigWalk\profiles\NewProfile"

# desktop app + package (big-replay)
dotnet publish src/BigReplay.Desktop/BigReplay.Desktop.csproj -c Release -r win-x64 `
  --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:DebugType=None -o dist/BigReplay
.\scripts\package-thunderstore.ps1            # -> dist\iameli-Big_Replay-<ver>.zip
.\scripts\test-exit-with-game.py              # smoke test (dummy process; notepad.exe is a stub on Win11 — use cmd/ping)

# upload: https://thunderstore.io/c/big-walk/create/  (team iameli) — bump <Version> FIRST
```

Version rules: single source of truth is `<Version>` in
`src/BigReplay.Desktop/BigReplay.Desktop.csproj` (currently **0.1.3**). Thunderstore rejects a
repeated `version_number`, so bump for every upload. The Inno installer uses a separate
`0.1.<GITHUB_RUN_NUMBER>` scheme — different numbering, don't confuse them. The launcher plugin
is at 0.1.1 (its code hasn't changed since 0.1.1).

## 3. The modded-launch crash (most important open knowledge)

**Symptom.** A profile without a valid pre-generated `BepInEx/interop/` crashes the game ~3–5 s
into a modded launch: native AV, `UnityPlayer.dll+0x48e5dd`, exception `0xc0000005`; faulting
instruction is `mov ebx,[r14+8]` (a hash-table lookup called with a corrupt pointer). No managed
exception, **no `BepInEx/LogOutput.log`**, `BepInEx/ErrorLog.log` exists but is empty, and no
`preloader_*.log`.

Two red herrings worth remembering:
- `ErrorLog.log` is **not** a BepInEx log — it is a raw `CreateFile` **stderr redirect** created
  unconditionally at preloader start (`RedirectStdErrFix`), so "exists but empty" means nothing.
- `preloader_*.log` (next to the game exe) is written only when doorstop's `Entrypoint.Start()`
  catches a managed exception. Its absence proves the crash was **native**, not managed.

**Root cause.** BepInEx's in-process interop generation. Console capture from a fresh profile:
```
[Message:InteropManager] Extracting unity base libraries from <profile>\BepInEx\unity-libs\6000.3.17.zip
[Message:InteropManager] Running Cpp2IL to generate dummy assemblies from …global-metadata.dat
[Info: Cpp2IL] … Initialized Metadata … Initialized Binary … Processed 157744 OK
[Info: Cpp2IL] [Program] Creating application model...      <- dies here
```
i.e. Cpp2IL's application-model construction inside the injected CLR AVs.

**Fix that works.** Seed a complete `BepInEx/interop/` (+ `unity-libs/`) so generation is skipped:
`CheckIfGenerationRequired()` compares an MD5 stored in `interop/assembly-hash.txt` over
`GameAssembly.dll` + `unity-libs/*.dll` (name + bytes) + the Il2CppInterop.Generator and
Cpp2IL.Core assembly versions. With a matching hash + a full interop set (154 dlls + the two
`*.db` caches), BepInEx logs `Chainloader initialized` → `Chainloader startup complete` and the
game boots. **This is how `NewProfile` was made to work** (copied from `Default`).

**Is it universal?** Evidence says **no — likely machine/environment-specific or flaky**:
generation succeeded on this box before (a working 154-dll set exists, and the project docs
describe first-launch generation as normal); both be.755 and be.785 fail identically here;
the game build is unchanged (buildid `24982892`, binaries from Aug); community modding otherwise
works. A second data point is pending: **a fresh install on the user's laptop**.

**Decision taken:** do **not** ship interop in the package yet (assume generation usually
succeeds). The package README documents the workaround: relaunch (generation restarts each run)
or copy a working `BepInEx/interop` folder in. If the laptop also fails, the fix is to have
`package-thunderstore.ps1` (and `install.ps1` in the mods repo) seed `interop/` + `unity-libs/`
from a bundled copy — it is version-locked to the pinned game build, same policy as
`manifest.json`.

**Repro/verify recipe:** delete `<profile>/BepInEx/interop` (or just `assembly-hash.txt`) →
Start Modded → crash at generation; restore the folder → boots.

## 4. Environment quirks

- r2modman "Start Modded" **stages its active profile into the game folder per launch and cleans
  up after** — and the staged set is partial (it stages `doorstop_config.ini`, `dotnet/`,
  `changelog.txt`, `BigReplay/`, … but not always `BepInEx/` or `winhttp.dll`). Never diagnose
  from the game folder; read the profile. Direct launches of `Big Walk.exe` work for loader
  testing only while the game folder actually contains a loader.
- The game folder was restored to vanilla at one point with the mods repo's
  `scripts/uninstall.ps1 -KeepCache`; keep it vanilla (r2modman manages the profile).
- `notepad.exe` on Win11 is a stub that hands off to the Store app and exits in ~1 s — it broke
  the first `--exit-with-game` smoke test. Use `cmd /c ping -n N 127.0.0.1 > nul` as the dummy.
- Profile-based testing state: `profiles\Default` (original, has a working interop set) and
  `profiles\NewProfile` (fresh + seeded interop + launcher + payload; **the launcher was live-
  verified here** — Big Replay opens with the game).

## 5. Verified this session

- `dist/iameli-Big_Replay-0.1.3.zip` — 9 entries, LICENSE first line `MIT License`, manifest
  version 0.1.3, launcher DLL + payload intact, README has the security note + troubleshooting.
- Shipped `BigReplay.exe` honors `--exit-with-game` (stays up while the target lives, saves and
  exits ~3 s after it dies with `--grace 2`).
- Launcher live test: NewProfile modded launch → Big Replay auto-opened; game quit → Big Replay
  saved and closed.
- Zip-side checks: required root files, icon exactly 256×256, name charset, description ≤250,
  dependency format.

## 6. Open items / next steps

1. **Laptop fresh-install data point** (interop generation on another machine) — decides whether
   we ship seeded interop.
2. **First CI run** of the new packaging steps (codesign/refs URL/`gh release create` asset list).
3. Optional: `tcli` auto-publish to Thunderstore from CI with a service token.
4. When the group adopts a new game build: regenerate `manifest.json` (ManifestGen) **and**
   regenerate/refresh any seeded interop; both are version-locked.
5. The mods repo's other plugins (Practice/DevMenu/SkipIntro) share the same first-launch
   interop fragility in fresh game-folder installs — apply the same seeding if that flow matters.
6. `PLAN.md` still describes the recorder-era plan; fold anything still useful into docs and
   retire it when convenient.

## 7. File map (what to read first)

- `mods/BigWalk.ReplayLauncher/Plugin.cs` (mods repo) — the whole launcher; ~130 lines.
- `src/BigReplay.Desktop/Program.cs` — CLI parsing (`--exit-with-game`, `--grace`) + mutex.
- `src/BigReplay.Desktop/RecorderForm.cs` — watchdog (`ExitWatcherAsync`, `GraceElapsedAsync`,
  `IsGameAlive`), monitoring loop, graceful save-and-close path.
- `scripts/package-thunderstore.ps1` — package builder + validation + upload hints.
- `.github/workflows/release.yml` — release + CI packaging + Pages deploy.
- `installer/thunderstore/{README,CHANGELOG}.md` — the Thunderstore listing content.
- `docs/trust.md` — the read-only/no-injection trust story (keep it accurate).
- `docs/format.md`, `schemas/replay-v1.schema.json` — replay format contract.

## 8. Big Walk 1.6.0 repin (2026-10-05) — and a crash-model correction

**Build**: game version `1.6.0 2609301522` (from `Player.log`), Steam buildid **25723723**,
`GameAssembly.dll` 71,250,432 B (mtime 15:30), `global-metadata.dat` 20,269,204 B **v39**,
`data.unity3d` rewritten, Unity unchanged 6000.3.17f1.

**Repin done**: `ManifestGen` constants and `manifest.json` regenerated — `ImageSize` 74084352,
`MetaregRva` 57867008, `TypesTableRva` 58415072, `FieldOffsetsTableRva` 63269808, 74793 types,
21728 field offsets. The instance layout the recorder uses is unchanged (`mover@0x90`,
`registry@0xF0`, `sleeper@0x108`, `playerNetworking@0x1A0`, `bypassUpdate@0x1EB`,
`username@0xF0`, `identifier@0xF8`; only `PlayerNetworking.isPending` moved 0x150→0x158), and the
runtime-verified `PnUsername=0x100` / `PnIdentifier=0x118` still hold — verified live against a
running 1.6.0 session (3 players, names + positions, 45 gourds). `ManifestGen` now warns and
continues when a pinned field is renamed instead of aborting (`<username>/<identifier>k__BackingField`
no longer exist in 1.6.0, and the recorder does not use them).

**Crash model correction — there are two signatures, not one.** From WER buckets + the 10 dumps:
- `UnityPlayer.dll+0x48e5dd`, ~5 s after start (7 events on 2026-10-05 between 13:20 and 13:27):
  the startup/interop crash. It **stopped when the profile's `BepInEx/interop` was regenerated**
  at 13:27 — and generation itself *succeeded* (158 entries + hash + both `.db` caches, and again
  in ~27 s for the 15:30 build). So in-process generation is not universally broken on this box.
- `UnityPlayer.dll+0xb139c1`, after real play (uptimes 0.7 / 4.3 / **19.6** / 2.1 min): a
  **shutdown** crash. `Player-prev.log` ends with the game's own
  `Shipmate.Porting.AbstractPlatformManager<T>.OnDestroy()` NullReferenceException, the faulting
  thread's stack is all OS/D3D/TSM plumbing, and one occurrence had **no CLR loaded at all** (no
  `coreclr`, no BepInEx, 123 modules) — so it is a **game-side teardown bug**, present before and
  after the 15:30 hotfix, not caused by mods, LiveSplit/Uhhara (no injected module in any dump) or
  Big Replay (was not running).
  Bug-report repro: quit the game → crash dialog; cite `UnityPlayer.dll+0xb139c1` and the
  `OnDestroy` NRE.

**After every game update** (release chores, not code changes): publish a payload/Thunderstore
release (the package bundles this manifest), run `scripts/export-build-refs.ps1` and re-upload
`build-refs.zip` to `practice-canary` for CI, and rebuild plugins against the new interop.