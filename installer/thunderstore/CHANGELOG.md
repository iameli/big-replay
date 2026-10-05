# Changelog

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