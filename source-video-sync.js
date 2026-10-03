"use strict";

class SourceVideoSync {
  constructor({ video, playerSelect, fileInput, status, markButton, clearButton, list, pauseReplay, selectPlayer }) {
    this.video = video;
    this.playerSelect = playerSelect;
    this.fileInput = fileInput;
    this.status = status;
    this.markButton = markButton;
    this.clearButton = clearButton;
    this.list = list;
    this.pauseReplay = pauseReplay;
    this.onSelectPlayer = selectPlayer;
    this.playerIds = [];
    this.labels = new Map();
    this.sources = new Map();
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
    video.addEventListener("loadedmetadata", () => this.updateActiveStatus());
    video.addEventListener("error", () => {
      this.status.textContent = "Could not read this recording. Try a browser-supported MP4/WebM file.";
      this.updateButtons();
    });
  }

  setPlayers(playerIds, labelPlayer, replayEndTime) {
    this.clearSources();
    this.playerIds = playerIds.slice(0, 12);
    this.replayEndTime = replayEndTime;
    this.labels = new Map(this.playerIds.map(id => [id, labelPlayer(id)]));
    this.playerSelect.replaceChildren(...this.playerIds.map(id => new Option(this.labels.get(id), String(id))));
    this.playerSelect.disabled = !this.playerIds.length;
    this.fileInput.disabled = !this.playerIds.length;
    this.activePlayerId = this.playerIds[0] ?? null;
    if (this.activePlayerId !== null) this.playerSelect.value = String(this.activePlayerId);
    this.showPlayer(this.activePlayerId);
    this.renderList();
  }

  refreshLabels(labelPlayer) {
    this.labels = new Map(this.playerIds.map(id => [id, labelPlayer(id)]));
    for (const option of this.playerSelect.options) option.textContent = this.labels.get(Number(option.value));
    this.renderList();
    this.updateActiveStatus();
  }

  assign(playerId, file) {
    this.sources.set(playerId, { file, teleportTime: null });
    this.showPlayer(playerId);
    this.renderList();
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
      this.status.textContent = playerId === null
        ? "Load a replay before assigning recordings."
        : `No recording selected for ${this.labels.get(playerId)}.`;
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
    if (!source || this.video.readyState < HTMLMediaElement.HAVE_METADATA || !Number.isFinite(this.replayEndTime)) return;
    source.teleportTime = this.video.currentTime;
    this.updateActiveStatus();
    this.renderList();
  }

  clearTeleport() {
    const source = this.sources.get(this.activePlayerId);
    if (!source) return;
    source.teleportTime = null;
    this.updateActiveStatus();
    this.renderList();
  }

  sync(replayTime, playing, rate, forceSeek = false) {
    const source = this.sources.get(this.activePlayerId);
    if (!source || source.teleportTime === null || this.video.readyState < HTMLMediaElement.HAVE_METADATA) return;

    const sourceTime = replayTime + source.teleportTime - this.replayEndTime;
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
    const offset = source.teleportTime - this.replayEndTime;
    this.status.textContent = `${this.labels.get(this.activePlayerId)} · Big Teleport ${this.formatTime(source.teleportTime)} ↔ replay end ${this.formatTime(this.replayEndTime)} · source offset ${this.formatOffset(offset)}`;
  }

  updateButtons() {
    const source = this.sources.get(this.activePlayerId);
    this.markButton.disabled = !source || this.video.readyState < HTMLMediaElement.HAVE_METADATA || !Number.isFinite(this.replayEndTime);
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
        ? `${source.file.name}${source.teleportTime === null ? " · unmarked" : ` · ${this.formatOffset(source.teleportTime - this.replayEndTime)}`}`
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
