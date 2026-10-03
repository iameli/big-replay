"use strict";

function ffmpegSeconds(seconds) {
  return Math.max(0, seconds).toFixed(3);
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function ffmpegMosaicStartTime(sources) {
  return Math.max(0, ...sources.map(source => -source.offset));
}

function buildFfmpegMosaicCommand(sources, replayEndTime) {
  if (!Array.isArray(sources) || sources.length !== 12) {
    throw new Error("A 4×3 mosaic requires exactly 12 ordered sources.");
  }
  if (!Number.isFinite(replayEndTime) || replayEndTime <= 0) {
    throw new Error("Replay end time must be a positive number.");
  }
  if (sources.some(source => !source || !source.fileName || !Number.isFinite(source.offset))) {
    throw new Error("Each mosaic source requires a filename and finite offset.");
  }

  const startTime = ffmpegMosaicStartTime(sources);
  if (startTime >= replayEndTime) throw new Error("The source recordings do not overlap the replay.");
  const duration = ffmpegSeconds(replayEndTime - startTime);
  const command = ["ffmpeg", "-hide_banner", "-n"];
  for (const source of sources) command.push("-i", quotePowerShell(source.fileName));

  const filters = [];
  sources.forEach((source, index) => {
    const sourceStart = ffmpegSeconds(startTime + source.offset);
    filters.push(
      `[${index}:v]trim=start=${sourceStart},setpts=PTS-STARTPTS,fps=30,`
        + "scale=640:360:force_original_aspect_ratio=decrease,"
        + "pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,"
        + `tpad=stop_mode=clone:stop_duration=${duration}:color=black,`
        + `trim=duration=${duration},setpts=PTS-STARTPTS[v${index}]`,
      `[${index}:a:0]atrim=start=${sourceStart},asetpts=PTS-STARTPTS,`
        + `apad=pad_dur=${duration},atrim=duration=${duration}[a${index}]`,
    );
  });
  const labels = sources.map((_, index) => `[v${index}]`).join("");
  const layout = "0_0|640_0|1280_0|1920_0|0_360|640_360|1280_360|1920_360|0_720|640_720|1280_720|1920_720";
  filters.push(`${labels}xstack=inputs=12:layout=${layout}:fill=black:shortest=1[out]`);
  command.push("-filter_complex", quotePowerShell(filters.join(";")), "-map", quotePowerShell("[out]"));
  for (let index = 0; index < sources.length; index++) {
    command.push("-map", quotePowerShell(`[a${index}]`));
  }
  command.push(
    "-t", duration,
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-c:a", "aac", "-b:a", "160k",
  );
  sources.forEach((source, index) => {
    command.push(`-metadata:s:a:${index}`, quotePowerShell(`title=${source.title || source.fileName}`));
    command.push(`-disposition:a:${index}`, index === 0 ? "default" : "0");
  });
  command.push(
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    quotePowerShell("big-replay-4x3-synced.mp4"),
  );
  return command.join(" ");
}

class SourceVideoSync {
  constructor({
    video, playerSelect, fileInput, status, markButton, clearButton, list,
    generateButton, copyButton, commandOutput, commandStatus, setMosaicStartTime,
    pauseReplay, selectPlayer,
  }) {
    this.video = video;
    this.playerSelect = playerSelect;
    this.fileInput = fileInput;
    this.status = status;
    this.markButton = markButton;
    this.clearButton = clearButton;
    this.list = list;
    this.generateButton = generateButton;
    this.copyButton = copyButton;
    this.commandOutput = commandOutput;
    this.commandStatus = commandStatus;
    this.onMosaicStartTime = setMosaicStartTime;
    this.pauseReplay = pauseReplay;
    this.onSelectPlayer = selectPlayer;
    this.playerIds = [];
    this.labels = new Map();
    this.sources = new Map();
    this.replayTeleportTime = NaN;
    this.replayEndTime = NaN;
    this.activePlayerId = null;
    this.objectUrl = null;

    playerSelect.addEventListener("change", () => {
      const playerId = Number(playerSelect.value);
      this.showPlayer(playerId);
      this.onSelectPlayer(playerId);
    });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      if (file && this.activePlayerId !== null) this.assign(this.activePlayerId, file);
      fileInput.value = "";
    });
    markButton.addEventListener("click", () => {
      this.pauseReplay();
      this.markTeleport();
    });
    clearButton.addEventListener("click", () => this.clearTeleport());
    generateButton.addEventListener("click", () => this.generateCommand());
    copyButton.addEventListener("click", () => this.copyCommand());
    video.addEventListener("loadedmetadata", () => this.updateActiveStatus());
    video.addEventListener("error", () => {
      this.status.textContent = "Could not read this recording. Try a browser-supported MP4/WebM file.";
      this.updateButtons();
    });
  }

  setPlayers(playerIds, labelPlayer, replayTeleportTime, replayEndTime) {
    this.clearSources();
    this.playerIds = playerIds.slice(0, 12);
    this.replayTeleportTime = replayTeleportTime;
    this.replayEndTime = replayEndTime;
    this.labels = new Map(this.playerIds.map(id => [id, labelPlayer(id)]));
    this.playerSelect.replaceChildren(...this.playerIds.map(id => new Option(this.labels.get(id), String(id))));
    this.playerSelect.disabled = !this.playerIds.length;
    this.fileInput.disabled = !this.playerIds.length;
    this.activePlayerId = this.playerIds[0] ?? null;
    if (this.activePlayerId !== null) this.playerSelect.value = String(this.activePlayerId);
    this.showPlayer(this.activePlayerId);
    this.renderList();
    this.invalidateCommand();
  }

  refreshPlayers(playerIds, labelPlayer) {
    const selectedPlayer = this.activePlayerId;
    this.playerIds = playerIds.slice(0, 12);
    this.labels = new Map(this.playerIds.map(id => [id, labelPlayer(id)]));
    this.playerSelect.replaceChildren(...this.playerIds.map(id => new Option(this.labels.get(id), String(id))));
    this.playerSelect.disabled = !this.playerIds.length;
    this.fileInput.disabled = !this.playerIds.length;
    this.activePlayerId = this.playerIds.includes(selectedPlayer) ? selectedPlayer : (this.playerIds[0] ?? null);
    if (this.activePlayerId !== null) this.playerSelect.value = String(this.activePlayerId);
    this.renderList();
    this.updateActiveStatus();
    this.invalidateCommand();
  }

  refreshLabels(labelPlayer) {
    this.refreshPlayers(this.playerIds, labelPlayer);
  }

  assign(playerId, file) {
    this.sources.set(playerId, { file, teleportTime: null });
    this.showPlayer(playerId);
    this.renderList();
    this.invalidateCommand();
  }

  selectPlayer(playerId) {
    if (!this.playerIds.includes(playerId)) return;
    this.playerSelect.value = String(playerId);
    this.showPlayer(playerId);
  }

  showPlayer(playerId) {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.activePlayerId = playerId;
    const source = this.sources.get(playerId);
    if (!source) {
      if (playerId === null) {
        this.status.textContent = "Load a replay before assigning recordings.";
      } else if (Number.isFinite(this.replayTeleportTime)) {
        this.status.textContent = `No recording selected for ${this.labels.get(playerId)} · replay Big Teleport ${this.formatTime(this.replayTeleportTime)}.`;
      } else {
        this.status.textContent = `No recording selected for ${this.labels.get(playerId)} · Big Teleport not detected in this replay.`;
      }
      this.updateButtons();
      this.renderList();
      return;
    }

    this.objectUrl = URL.createObjectURL(source.file);
    this.status.textContent = `Loading ${source.file.name}…`;
    this.video.src = this.objectUrl;
    this.updateButtons();
    this.renderList();
  }

  markTeleport() {
    const source = this.sources.get(this.activePlayerId);
    if (!source || this.video.readyState < HTMLMediaElement.HAVE_METADATA || !Number.isFinite(this.replayTeleportTime)) return;
    source.teleportTime = this.video.currentTime;
    this.updateActiveStatus();
    this.renderList();
    this.invalidateCommand();
  }

  clearTeleport() {
    const source = this.sources.get(this.activePlayerId);
    if (!source) return;
    source.teleportTime = null;
    this.updateActiveStatus();
    this.renderList();
    this.invalidateCommand();
  }

  sync(replayTime, playing, rate, forceSeek = false) {
    const source = this.sources.get(this.activePlayerId);
    if (!source || source.teleportTime === null || this.video.readyState < HTMLMediaElement.HAVE_METADATA) return;

    const sourceTime = replayTime + source.teleportTime - this.replayTeleportTime;
    const target = Math.min(Math.max(0, sourceTime), Math.max(0, this.video.duration - 0.001));
    this.video.playbackRate = Math.min(16, Math.max(0.0625, rate));
    if (forceSeek || !playing || Math.abs(this.video.currentTime - target) > 0.25) this.video.currentTime = target;
    if (playing && sourceTime >= 0 && sourceTime < this.video.duration) {
      if (this.video.paused) this.video.play().catch(() => {
        this.status.textContent = "Recording is aligned; press Play again if the browser blocked playback.";
      });
    } else {
      this.video.pause();
    }
  }

  updateActiveStatus() {
    const source = this.sources.get(this.activePlayerId);
    this.updateButtons();
    if (!source) return;
    const duration = Number.isFinite(this.video.duration) ? ` · ${this.formatTime(this.video.duration)}` : "";
    if (source.teleportTime === null) {
      this.status.textContent = `${this.labels.get(this.activePlayerId)} · ${source.file.name}${duration} · Big Teleport not marked`;
      return;
    }
    const offset = source.teleportTime - this.replayTeleportTime;
    this.status.textContent = `${this.labels.get(this.activePlayerId)} · Big Teleport ${this.formatTime(source.teleportTime)} ↔ replay Big Teleport ${this.formatTime(this.replayTeleportTime)} · source offset ${this.formatOffset(offset)}`;
  }

  updateButtons() {
    const source = this.sources.get(this.activePlayerId);
    this.markButton.disabled = !source || this.video.readyState < HTMLMediaElement.HAVE_METADATA || !Number.isFinite(this.replayTeleportTime);
    this.clearButton.disabled = !source || source.teleportTime === null;
  }

  renderList() {
    this.list.replaceChildren(...this.playerIds.map(playerId => {
      const source = this.sources.get(playerId);
      const row = document.createElement("div");
      row.className = "source-video-row";
      if (playerId === this.activePlayerId) row.classList.add("active");
      const detail = document.createElement("span");
      detail.textContent = source
        ? `${source.file.name}${source.teleportTime === null ? " · unmarked" : ` · ${this.formatOffset(source.teleportTime - this.replayTeleportTime)}`}`
        : "No file";
      detail.title = detail.textContent;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "btn";
      open.textContent = this.labels.get(playerId);
      open.addEventListener("click", () => {
        this.playerSelect.value = String(playerId);
        this.showPlayer(playerId);
        this.onSelectPlayer(playerId);
      });
      row.append(open, detail);
      return row;
    }));
  }

  invalidateCommand() {
    this.commandOutput.value = "";
    this.commandOutput.hidden = true;
    this.copyButton.disabled = true;
    this.updateGeneratorStatus();
  }

  generatorState() {
    if (!this.playerIds.length) {
      return { ready: false, message: "Load a replay before generating a mosaic command." };
    }
    if (!Number.isFinite(this.replayTeleportTime)) {
      return { ready: false, message: "Big Teleport could not be detected in this replay." };
    }
    if (!Number.isFinite(this.replayEndTime)) {
      return { ready: false, message: "The replay has no valid end timestamp." };
    }
    if (this.playerIds.length !== 12) {
      return { ready: false, message: `A 4×3 mosaic requires 12 players; this replay has ${this.playerIds.length}.` };
    }
    const canonical = this.playerIds.every((id, index) =>
      canonicalPlayerNumber(this.labels.get(id)) === index + 1);
    if (!canonical) {
      return { ready: false, message: "Player names must begin with unique P1 through P12 labels." };
    }
    const assigned = this.playerIds.filter(id => this.sources.has(id)).length;
    const marked = this.playerIds.filter(id => this.sources.get(id)?.teleportTime !== null
      && this.sources.get(id)?.teleportTime !== undefined).length;
    if (marked < 12) {
      return {
        ready: false,
        message: `${assigned}/12 recordings assigned · ${marked}/12 Big Teleports marked.`,
      };
    }
    return { ready: true, message: "Ready to generate a P1–P12 PowerShell command." };
  }

  updateGeneratorStatus() {
    const state = this.generatorState();
    this.generateButton.disabled = !state.ready;
    this.commandStatus.textContent = state.message;
  }

  generateCommand() {
    const state = this.generatorState();
    if (!state.ready) {
      this.updateGeneratorStatus();
      return;
    }
    const sources = this.commandSources();
    const startTime = ffmpegMosaicStartTime(sources);
    this.commandOutput.value = buildFfmpegMosaicCommand(sources, this.replayEndTime);
    this.commandOutput.hidden = false;
    this.copyButton.disabled = false;
    this.onMosaicStartTime(startTime);
    this.commandStatus.textContent = `Generated in P1–P12 tile order with twelve AAC audio tracks · starts at replay ${this.formatTime(startTime)}. Run it in PowerShell from the recordings folder.`;
  }

  commandSources() {
    return this.playerIds.map(playerId => {
      const source = this.sources.get(playerId);
      return {
        fileName: source.file.name,
        title: this.labels.get(playerId),
        offset: source.teleportTime - this.replayTeleportTime,
      };
    });
  }

  buildFfmpegCommand() {
    return buildFfmpegMosaicCommand(this.commandSources(), this.replayEndTime);
  }

  async copyCommand() {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(this.commandOutput.value);
      } else {
        this.commandOutput.hidden = false;
        this.commandOutput.select();
        if (!document.execCommand("copy")) throw new Error("Copy was not available");
      }
      this.commandStatus.textContent = "FFmpeg command copied.";
    } catch {
      this.commandOutput.focus();
      this.commandOutput.select();
      this.commandStatus.textContent = "Automatic copy was unavailable; the command is selected for manual copying.";
    }
  }

  clearSources() {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.sources.clear();
  }

  formatOffset(seconds) {
    return `${seconds < 0 ? "−" : "+"}${Math.abs(seconds).toFixed(3)}s`;
  }

  formatTime(seconds) {
    const milliseconds = Math.floor(seconds * 1000) % 1000;
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor(whole / 60) % 60;
    const remainder = whole % 60;
    return `${hours ? `${hours}:` : ""}${hours ? String(minutes).padStart(2, "0") : minutes}:${String(remainder).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
  }
}
