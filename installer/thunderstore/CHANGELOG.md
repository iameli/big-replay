# Changelog

## 0.1.5

- **Fixed class discovery for short class names** — recordings could come back with players but
  **zero gourds and zero monuments** for the entire run, silently. Discovery matched any occurrence
  of a class's NUL-terminated name, so `Prop\0` also hit the tail of `GourdProp\0`, `FruitProp\0`,
  …; it then stopped after three hits, and those interior addresses never point at a klass, so
  `Prop.allProps` (gourds) and `PropHome.allPropHomes` (monuments) could never resolve. Discovery now
  accepts only hits that begin a whole string.
- Repinned to Big Walk 1.6.0 in 0.1.4 (build 25723723): older payloads refuse a 1.6.0 game.

## 0.1.4

- Recorder repinned to Big Walk **1.6.0** (build 25723723, metadata still v39): new binary
  layout (`ImageSize` 74084352, shifted metadata/type/field tables), `PlayerNetworking.isPending`
  moved 0x150 → 0x158. Verified live against a running 1.6.0 session — 3 players with names and
  positions, 45 gourds. Older builds are still refused by the attach fingerprint check.

## 0.1.3

- Added an MIT "LICENSE" to the repository and to the package.

## 0.1.2

- Documentation correction: **any player in the lobby can run Big Replay** — player, gourd and
  monument state is replicated to every client, so the recorder no longer needs to run on the
  host. (Recorder window hint text updated to match.)
- The Thunderstore package is now built in CI and attached to every GitHub release
  (`Big_Replay-<version>.zip`), alongside the installer and portable zip.

## 0.1.1

- Removed the launcher's executable-path config entry. BepInEx configs are shared as codes, so
  a path setting would let a shared config point the launcher at an arbitrary program. The
  payload location is now fixed at `<profile>/BigReplay/BigReplay.exe`.
- Package README: troubleshooting notes for the first-launch interop generation step.

## 0.1.0

- Initial release: launches the standalone Big Replay recorder alongside a modded Big Walk
  launch, and closes it (saving the current replay) after the game exits — crash-proof via
  process watching, with a relaunch grace period.