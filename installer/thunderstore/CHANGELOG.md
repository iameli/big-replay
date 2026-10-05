# Changelog

## 0.1.1

- Removed the launcher's executable-path config entry. BepInEx configs are shared as codes, so
  a path setting would let a shared config point the launcher at an arbitrary program. The
  payload location is now fixed at `<profile>/BigReplay/BigReplay.exe`.
- Package README: troubleshooting notes for the first-launch interop generation step.

## 0.1.0

- Initial release: launches the standalone Big Replay recorder alongside a modded Big Walk
  launch, and closes it (saving the current replay) after the game exits — crash-proof via
  process watching, with a relaunch grace period.