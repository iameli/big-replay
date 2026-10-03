"use strict";

const STREAMPLACE_PLAYLIST_ENDPOINT = "https://stream.place/xrpc/place.stream.playback.getVideoPlaylist";
const HLS_MODULE_URL = "https://cdn.jsdelivr.net/npm/hls.js@1.6.15/+esm";

function streamplacePlaylistUrl(uri) {
  return `${STREAMPLACE_PLAYLIST_ENDPOINT}?uri=${encodeURIComponent(uri)}`;
}

function replayFrameIndexAtOrAfter(frames, time) {
  if (!Array.isArray(frames) || !frames.length || !Number.isFinite(time)) return 0;
  let low = 0, high = frames.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (frames[middle].time < time) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, frames.length - 1);
}

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
    this.sourceKind = null;
    this.hls = null;
    this.loadToken = 0;
    this.timelineStart = 0;
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
    video.addEventListener("seeked", () => {
      this.draw();
      this.resumePlayback();
    });
    video.addEventListener("error", () => {
      this.ready = false;
      this.status.textContent = this.sourceKind === "streamplace"
        ? "Could not play the Streamplace video. Choose a local mosaic to override it."
        : "Could not read that video. Use a browser-supported MP4/WebM mosaic.";
    });
  }

  load(file) {
    this.clearMedia();
    this.sourceKind = "local";
    this.video.removeAttribute("crossorigin");
    this.objectUrl = URL.createObjectURL(file);
    this.status.textContent = `Loading ${file.name}…`;
    this.video.src = this.objectUrl;
  }

  async loadStreamplace(uri) {
    if (this.sourceKind === "local") return;
    this.clearMedia();
    this.sourceKind = "streamplace";
    const token = this.loadToken;
    const playlist = streamplacePlaylistUrl(uri);
    this.video.crossOrigin = "anonymous";
    this.status.textContent = "Loading default mosaic from Streamplace…";

    if (this.video.canPlayType("application/vnd.apple.mpegurl")) {
      this.video.src = playlist;
      return;
    }

    try {
      const module = await import(HLS_MODULE_URL);
      if (token !== this.loadToken) return;
      const Hls = module.default;
      if (!Hls.isSupported()) throw new Error("HLS playback is not supported in this browser");
      const hls = new Hls();
      this.hls = hls;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (this.hls !== hls || !data.fatal) return;
        this.ready = false;
        this.status.textContent = "Could not play the Streamplace video. Choose a local mosaic to override it.";
        hls.destroy();
        if (this.hls === hls) this.hls = null;
      });
      hls.loadSource(playlist);
      hls.attachMedia(this.video);
    } catch {
      if (token !== this.loadToken) return;
      this.status.textContent = "Could not start Streamplace playback. Choose a local mosaic to override it.";
    }
  }

  setTimelineStart(seconds) {
    this.timelineStart = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    this.sync(this.targetTime, this.shouldPlay, this.rate, true);
  }

  reset() {
    this.clearMedia();
    this.sourceKind = null;
    this.timelineStart = 0;
    this.status.textContent = "No mosaic loaded. Video stays on this device.";
  }

  clearMedia() {
    this.loadToken++;
    this.cancelFrameLoop();
    this.ready = false;
    this.video.pause();
    if (this.hls) this.hls.destroy();
    this.hls = null;
    this.video.removeAttribute("src");
    this.video.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
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
    const source = this.sourceKind === "streamplace" ? "Streamplace mosaic" : "mosaic";
    const start = this.timelineStart ? ` · starts at replay ${this.formatDuration(this.timelineStart)}` : "";
    this.status.textContent = `${width}×${height} ${source} · 12 × ${tileWidth}×${tileHeight} views · ${this.formatDuration(this.video.duration)}${start}`;
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

  setVisibleIndices(indices) {
    const visible = new Set(indices);
    for (let index = 0; index < this.tiles.length; index++) {
      this.tiles[index].button.hidden = !visible.has(index);
    }
  }

  sync(time, playing, rate, forceSeek = false) {
    this.targetTime = Number.isFinite(time) ? Math.max(0, time) : 0;
    this.shouldPlay = playing;
    this.rate = rate;
    if (!this.ready) return;

    const videoTime = this.targetTime - this.timelineStart;
    if (videoTime < 0) {
      this.video.pause();
      this.clearTiles();
      return;
    }
    const end = Number.isFinite(this.video.duration) ? Math.max(0, this.video.duration - 0.001) : videoTime;
    const target = Math.min(videoTime, end);
    this.video.playbackRate = Math.min(16, Math.max(0.0625, rate));
    const drift = Math.abs(this.video.currentTime - target);
    const seekThreshold = forceSeek || !playing ? 0.001 : 0.25;
    if (!this.video.seeking && drift > seekThreshold) this.video.currentTime = target;
    if (playing && videoTime < this.video.duration) this.resumePlayback();
    else this.video.pause();
    if (!playing) this.draw();
  }

  resumePlayback() {
    const videoTime = this.targetTime - this.timelineStart;
    if (!this.ready || !this.shouldPlay || videoTime < 0 || videoTime >= this.video.duration) return;
    if (this.video.paused) this.video.play().catch(() => {
      this.status.textContent = "Video is ready; press Play again if the browser blocked playback.";
    });
  }

  waitForSeek() {
    if (!this.ready) return Promise.resolve();
    const token = this.loadToken;
    return new Promise(resolve => {
      let cleanup = () => {};
      const finish = () => {
        cleanup();
        resolve();
      };
      const settle = () => {
        cleanup();
        if (!this.ready || token !== this.loadToken) {
          finish();
          return;
        }
        const videoTime = this.targetTime - this.timelineStart;
        const end = Number.isFinite(this.video.duration)
          ? Math.max(0, this.video.duration - 0.001)
          : videoTime;
        const target = Math.min(Math.max(0, videoTime), end);
        if (!this.video.seeking && Math.abs(this.video.currentTime - target) <= 0.001) {
          finish();
          return;
        }
        const onSeeked = () => settle();
        const onStopped = () => finish();
        cleanup = () => {
          this.video.removeEventListener("seeked", onSeeked);
          this.video.removeEventListener("error", onStopped);
          this.video.removeEventListener("emptied", onStopped);
        };
        this.video.addEventListener("seeked", onSeeked);
        this.video.addEventListener("error", onStopped);
        this.video.addEventListener("emptied", onStopped);
        if (!this.video.seeking) {
          this.video.currentTime = target;
          if (!this.video.seeking) finish();
        }
      };
      settle();
    });
  }

  draw() {
    if (!this.ready || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (this.targetTime < this.timelineStart) {
      this.clearTiles();
      return;
    }
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

  clearTiles() {
    for (const { canvas, context } of this.tiles) context.clearRect(0, 0, canvas.width, canvas.height);
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
