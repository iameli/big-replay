"use strict";

class MosaicVideo {
  static COLUMNS = 4;
  static ROWS = 3;
  static TILE_COUNT = MosaicVideo.COLUMNS * MosaicVideo.ROWS;

  constructor(video, grid, status, onSelect) {
    this.video = video;
    this.grid = grid;
    this.status = status;
    this.onSelect = onSelect;
    this.tiles = [];
    this.playerIds = [];
    this.selectedIndex = -1;
    this.objectUrl = null;
    this.ready = false;
    this.targetTime = 0;
    this.shouldPlay = false;
    this.rate = 1;
    this.frameCallback = null;

    for (let index = 0; index < MosaicVideo.TILE_COUNT; index++) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "video-tile";
      button.dataset.tile = index;
      button.setAttribute("aria-pressed", "false");

      const canvas = document.createElement("canvas");
      const label = document.createElement("span");
      label.textContent = `Camera ${index + 1}`;
      button.setAttribute("aria-label", `Focus camera ${index + 1}`);
      button.append(canvas, label);
      button.addEventListener("click", () => {
        this.selectIndex(index);
        const playerId = this.playerIds[index];
        if (playerId !== undefined) this.onSelect(playerId);
      });
      grid.append(button);
      this.tiles.push({ button, canvas, context: canvas.getContext("2d"), label });
    }

    video.addEventListener("loadedmetadata", () => this.loadedMetadata());
    video.addEventListener("loadeddata", () => this.draw());
    video.addEventListener("seeked", () => this.draw());
    video.addEventListener("error", () => {
      this.ready = false;
      this.status.textContent = "Could not read that video. Use a browser-supported MP4/WebM mosaic.";
    });
  }

  load(file) {
    this.cancelFrameLoop();
    this.ready = false;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    this.status.textContent = `Loading ${file.name}…`;
    this.video.src = this.objectUrl;
  }

  loadedMetadata() {
    const width = this.video.videoWidth, height = this.video.videoHeight;
    if (!width || !height || width % MosaicVideo.COLUMNS || height % MosaicVideo.ROWS) {
      this.ready = false;
      this.status.textContent = `Expected a 4×3 mosaic; got ${width || "?"}×${height || "?"}. Both dimensions must divide evenly.`;
      return;
    }

    const tileWidth = width / MosaicVideo.COLUMNS;
    const tileHeight = height / MosaicVideo.ROWS;
    for (const { canvas } of this.tiles) {
      canvas.width = tileWidth;
      canvas.height = tileHeight;
    }
    this.ready = true;
    this.status.textContent = `${width}×${height} mosaic · 12 × ${tileWidth}×${tileHeight} views · ${this.formatDuration(this.video.duration)}`;
    this.sync(this.targetTime, this.shouldPlay, this.rate, true);
    this.startFrameLoop();
  }

  setPlayers(playerIds, labelPlayer) {
    const selectedPlayer = this.playerIds[this.selectedIndex];
    this.playerIds = playerIds.slice(0, MosaicVideo.TILE_COUNT);
    for (let index = 0; index < this.tiles.length; index++) {
      const playerId = this.playerIds[index];
      const text = playerId === undefined ? `Camera ${index + 1}` : labelPlayer(playerId);
      const { button, label } = this.tiles[index];
      label.textContent = text;
      button.setAttribute("aria-label", playerId === undefined ? `Focus camera ${index + 1}` : `Focus video for ${text}`);
    }
    this.selectIndex(this.playerIds.indexOf(selectedPlayer));
  }

  refreshLabels(labelPlayer) {
    this.setPlayers(this.playerIds, labelPlayer);
  }

  selectPlayer(playerId) {
    const index = this.playerIds.indexOf(playerId);
    if (index >= 0) this.selectIndex(index);
  }

  selectIndex(index) {
    this.selectedIndex = index;
    for (let i = 0; i < this.tiles.length; i++) {
      const selected = i === index;
      this.tiles[i].button.classList.toggle("selected", selected);
      this.tiles[i].button.setAttribute("aria-pressed", String(selected));
    }
  }

  sync(time, playing, rate, forceSeek = false) {
    this.targetTime = Number.isFinite(time) ? Math.max(0, time) : 0;
    this.shouldPlay = playing;
    this.rate = rate;
    if (!this.ready) return;

    const end = Number.isFinite(this.video.duration) ? Math.max(0, this.video.duration - 0.001) : this.targetTime;
    const target = Math.min(this.targetTime, end);
    this.video.playbackRate = Math.min(16, Math.max(0.0625, rate));
    if (forceSeek || !playing || Math.abs(this.video.currentTime - target) > 0.25) {
      this.video.currentTime = target;
    }
    if (playing && this.targetTime < this.video.duration) {
      if (this.video.paused) this.video.play().catch(() => {
        this.status.textContent = "Video is ready; press Play again if the browser blocked playback.";
      });
    } else {
      this.video.pause();
    }
    if (!playing) this.draw();
  }

  draw() {
    if (!this.ready || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const tileWidth = this.video.videoWidth / MosaicVideo.COLUMNS;
    const tileHeight = this.video.videoHeight / MosaicVideo.ROWS;
    for (let index = 0; index < this.tiles.length; index++) {
      const sourceX = (index % MosaicVideo.COLUMNS) * tileWidth;
      const sourceY = Math.floor(index / MosaicVideo.COLUMNS) * tileHeight;
      this.tiles[index].context.drawImage(
        this.video, sourceX, sourceY, tileWidth, tileHeight,
        0, 0, tileWidth, tileHeight,
      );
    }
  }

  startFrameLoop() {
    if (!("requestVideoFrameCallback" in this.video)) return;
    const draw = () => {
      this.draw();
      this.frameCallback = this.video.requestVideoFrameCallback(draw);
    };
    this.frameCallback = this.video.requestVideoFrameCallback(draw);
  }

  cancelFrameLoop() {
    if (this.frameCallback !== null && "cancelVideoFrameCallback" in this.video) {
      this.video.cancelVideoFrameCallback(this.frameCallback);
    }
    this.frameCallback = null;
  }

  formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return "unknown duration";
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }
}
