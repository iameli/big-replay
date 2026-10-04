"use strict";

const PLAYBACK_LAYOUT_STORAGE = "big-walk:playback-layouts:v1";
const PLAYBACK_LAYOUT_KEYS = Object.freeze([
  "map",
  ...Array.from({ length: 12 }, (_, index) => `p${index + 1}`),
]);

function playerLayoutKey(index) {
  return `p${index + 1}`;
}

function playbackPlayerCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.min(12, Math.max(0, Math.floor(count))) : 0;
}

function normalizePlaybackSelection(selection, playerCount = 12) {
  const available = new Set(["map"]);
  for (let index = 0; index < playbackPlayerCount(playerCount); index++) {
    available.add(playerLayoutKey(index));
  }
  const normalized = [];
  for (const key of Array.isArray(selection) ? selection : []) {
    if (available.has(key) && !normalized.includes(key)) normalized.push(key);
  }
  return normalized.length ? normalized : ["map"];
}

function normalizePlaybackSizing(value) {
  const mapFraction = Number.isFinite(value?.mapFraction)
    ? Math.min(0.9, Math.max(0.1, value.mapFraction)) : 0.65;
  const tracks = {};
  for (const [key, weights] of Object.entries(value?.tracks || {})) {
    if (!/^[cr][1-9]\d?$/.test(key) || !Array.isArray(weights) ||
        weights.length !== Number(key.slice(1)) ||
        !weights.every(weight => Number.isFinite(weight) && weight > 0)) continue;
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (Number.isFinite(total)) tracks[key] = weights.map(weight => weight / total);
  }
  return { mapFraction, tracks };
}

function normalizePlaybackModes(value) {
  return { squareVideos: value?.squareVideos === true, mapCameras: value?.mapCameras === true };
}

function placeMapCameras(cameras, width, height, size = 56) {
  const placed = [];
  const step = size + 8;
  const maxLeft = Math.max(0, width - size), maxTop = Math.max(0, height - size);
  for (const camera of cameras) {
    const originLeft = camera.x - size / 2, originTop = camera.y - size - 24;
    let left = Math.min(maxLeft, Math.max(0, originLeft));
    let top = Math.min(maxTop, Math.max(0, originTop));
    let found = false;
    for (let ring = 0; ring <= cameras.length && !found; ring++) {
      for (let dy = -ring; dy <= ring && !found; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const candidateLeft = Math.min(maxLeft, Math.max(0, originLeft + dx * step));
          const candidateTop = Math.min(maxTop, Math.max(0, originTop + dy * step));
          if (placed.some(other => candidateLeft < other.left + size + 4 &&
              candidateLeft + size + 4 > other.left && candidateTop < other.top + size + 4 &&
              candidateTop + size + 4 > other.top)) continue;
          left = candidateLeft;
          top = candidateTop;
          found = true;
          break;
        }
      }
    }
    placed.push({ ...camera, left, top, size });
  }
  return placed;
}

function normalizeSavedLayouts(value) {
  if (!Array.isArray(value)) return [];
  const layouts = [];
  for (const candidate of value) {
    const name = typeof candidate?.name === "string" ? candidate.name.trim() : "";
    if (!name) continue;
    const layout = {
      name, selection: normalizePlaybackSelection(candidate.selection),
      sizing: normalizePlaybackSizing(candidate.sizing),
      modes: normalizePlaybackModes(candidate.modes),
    };
    const existing = layouts.findIndex(saved => saved.name === name);
    if (existing >= 0) layouts.splice(existing, 1);
    layouts.push(layout);
  }
  return layouts;
}

function playbackGridShape(itemCount, width, height, gap = 8, aspectRatio = 16 / 9) {
  const count = Math.max(1, Math.floor(itemCount));
  let best = { columns: Math.ceil(Math.sqrt(count)), scale: -Infinity, empty: Infinity };
  if (width > 0 && height > 0 && aspectRatio > 0) {
    for (let columns = 1; columns <= count; columns++) {
      const rows = Math.ceil(count / columns);
      const cellWidth = (width - gap * (columns - 1)) / columns;
      const cellHeight = (height - gap * (rows - 1)) / rows;
      const scale = Math.min(cellWidth / aspectRatio, cellHeight);
      const empty = columns * rows - count;
      if (scale > best.scale + 0.001 ||
          (Math.abs(scale - best.scale) <= 0.001 && empty < best.empty)) {
        best = { columns, scale, empty };
      }
    }
  }
  const rows = Math.ceil(count / best.columns);
  const empty = best.columns * rows - count;
  const leadRows = rows > 1 && empty === rows - 1 ? rows : 1;
  return {
    columns: best.columns,
    rows,
    leadRows,
    trailingColumns: empty && leadRows === 1 ? empty + 1 : 1,
  };
}

function playbackGridColumns(itemCount, width, height, gap = 8, aspectRatio = 16 / 9) {
  return playbackGridShape(itemCount, width, height, gap, aspectRatio).columns;
}

class PlaybackLayoutState {
  constructor(savedLayouts = [], playerCount = 0) {
    this.playerCount = playbackPlayerCount(playerCount);
    this.selection = ["map"];
    this.savedLayouts = normalizeSavedLayouts(savedLayouts);
    this.sizing = normalizePlaybackSizing();
    this.modes = normalizePlaybackModes();
    this.maximizedPlayer = null;
  }

  setPlayerCount(playerCount) {
    this.playerCount = playbackPlayerCount(playerCount);
    this.selection = normalizePlaybackSelection(this.selection, this.playerCount);
    if (!this.selection.includes(this.maximizedPlayer)) this.maximizedPlayer = null;
  }

  setSelection(selection) {
    this.selection = normalizePlaybackSelection(selection, this.playerCount);
    this.maximizedPlayer = null;
  }

  showMosaicDefault() {
    this.selection = PLAYBACK_LAYOUT_KEYS.slice(0, this.playerCount + 1);
    this.sizing = normalizePlaybackSizing();
    this.maximizedPlayer = null;
  }

  toggle(key) {
    const available = normalizePlaybackSelection([key], this.playerCount)[0] === key;
    if (!available) return false;
    if (this.selection.includes(key)) {
      if (this.selection.length === 1) return false;
      this.selection = this.selection.filter(selected => selected !== key);
    } else {
      this.selection = PLAYBACK_LAYOUT_KEYS.filter(candidate =>
        candidate === key || this.selection.includes(candidate));
    }
    this.maximizedPlayer = null;
    return true;
  }

  addPlayer(index) {
    const key = playerLayoutKey(index);
    if (index < 0 || index >= this.playerCount || this.selection.includes(key)) return false;
    this.selection = PLAYBACK_LAYOUT_KEYS.filter(candidate =>
      candidate === key || this.selection.includes(candidate));
    return true;
  }

  maximizePlayer(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.playerCount) return false;
    this.maximizedPlayer = playerLayoutKey(index);
    return true;
  }

  save(name) {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) throw new Error("Enter a layout name.");
    const saved = {
      name: trimmed, selection: [...this.selection],
      sizing: normalizePlaybackSizing(this.sizing),
      modes: normalizePlaybackModes(this.modes),
    };
    const existing = this.savedLayouts.findIndex(layout => layout.name === trimmed);
    if (existing >= 0) this.savedLayouts.splice(existing, 1);
    this.savedLayouts.push(saved);
    return saved;
  }

  recall(name) {
    const saved = this.savedLayouts.find(layout => layout.name === name);
    if (!saved) return false;
    this.setSelection(saved.selection);
    this.sizing = normalizePlaybackSizing(saved.sizing);
    this.modes = normalizePlaybackModes(saved.modes);
    return true;
  }

  remove(name) {
    const index = this.savedLayouts.findIndex(layout => layout.name === name);
    if (index < 0) return false;
    this.savedLayouts.splice(index, 1);
    return true;
  }
}

// Separate the map from the camera grid so its size never depends on camera count.
class PlaybackLayoutRenderer {
  constructor(root, mapPanel, videoGrid, state, redrawMap) {
    this.root = root;
    this.mapPanel = mapPanel;
    this.videoGrid = videoGrid;
    this.state = state;
    this.redrawMap = redrawMap;
    this.dividers = [];
    this.signature = "";
    this.dragging = false;
  }

  update() {
    const tiles = [...this.videoGrid.querySelectorAll(".video-tile:not([hidden])")];
    const mixed = !this.mapPanel.hidden && tiles.length > 0;
    const vertical = this.root.clientWidth < 650;
    this.root.dataset.split = mixed ? (vertical ? "vertical" : "horizontal") : "single";
    this.videoGrid.hidden = tiles.length === 0;
    this.applySplit(mixed, vertical);
    const width = mixed && !vertical
      ? (this.root.clientWidth - 32) * (1 - this.state.sizing.mapFraction)
      : this.root.clientWidth - 24;
    const height = mixed && vertical
      ? (this.root.clientHeight - 32) * (1 - this.state.sizing.mapFraction)
      : this.root.clientHeight - 24;
    const square = this.state.modes.squareVideos && !this.state.maximizedPlayer;
    this.videoGrid.dataset.square = String(square);
    const shape = playbackGridShape(tiles.length, width, height, 8, square ? 1 : 16 / 9);
    this.applyTracks(shape);
    for (const tile of this.videoGrid.querySelectorAll(".video-tile")) {
      tile.style.gridRow = "";
      tile.style.gridColumn = "";
    }
    if (!square && tiles.length && shape.leadRows > 1) tiles[0].style.gridRow = `span ${shape.leadRows}`;
    else if (!square && tiles.length && shape.trailingColumns > 1) {
      tiles.at(-1).style.gridColumn = `span ${shape.trailingColumns}`;
    }
    if (square) {
      shape.leadRows = 1;
      shape.trailingColumns = 1;
    }
    this.fitCameraTiles();
    const signature = `${mixed}:${vertical}:${shape.columns}:${shape.rows}:${tiles.length}:${square}`;
    if (signature !== this.signature && !this.dragging) {
      this.signature = signature;
      this.rebuildDividers(mixed, vertical, shape);
    }
    this.positionDividers();
  }

  fitCameraTiles() {
    const square = this.state.modes.squareVideos && !this.state.maximizedPlayer;
    const tiles = [...this.videoGrid.querySelectorAll(".video-tile:not([hidden])")];
    for (const tile of this.videoGrid.querySelectorAll(".video-tile")) {
      tile.style.width = "";
      tile.style.height = "";
      tile.style.justifySelf = "";
      tile.style.alignSelf = "";
    }
    if (!square) return;
    const sizes = tiles.map(tile => {
      const box = tile.getBoundingClientRect();
      return Math.max(0, Math.min(box.width, box.height));
    });
    tiles.forEach((tile, index) => {
      tile.style.width = `${sizes[index]}px`;
      tile.style.height = `${sizes[index]}px`;
      tile.style.justifySelf = "center";
      tile.style.alignSelf = "center";
    });
  }

  applySplit(mixed, vertical) {
    const fraction = this.state.sizing.mapFraction;
    this.root.style.gridTemplateColumns = mixed && !vertical
      ? `minmax(0, ${fraction}fr) minmax(0, ${1 - fraction}fr)` : "minmax(0, 1fr)";
    this.root.style.gridTemplateRows = mixed && vertical
      ? `minmax(0, ${fraction}fr) minmax(0, ${1 - fraction}fr)` : "minmax(0, 1fr)";
  }

  weights(axis, count) {
    return this.state.sizing.tracks[axis + count] || Array(count).fill(1 / count);
  }

  applyTracks(shape) {
    this.videoGrid.style.gridTemplateColumns = this.weights("c", shape.columns)
      .map(weight => `minmax(0, ${weight}fr)`).join(" ");
    this.videoGrid.style.gridTemplateRows = this.weights("r", shape.rows)
      .map(weight => `minmax(0, ${weight}fr)`).join(" ");
  }

  rebuildDividers(mixed, vertical, shape) {
    for (const divider of this.dividers) divider.element.remove();
    this.dividers = [];
    if (mixed) this.addDivider("map", vertical ? "y" : "x", 0, 2, shape);
    for (let index = 0; index < shape.columns - 1; index++) {
      this.addDivider("c", "x", index, shape.columns, shape);
    }
    for (let index = 0; index < shape.rows - 1; index++) {
      this.addDivider("r", "y", index, shape.rows, shape);
    }
  }

  addDivider(kind, axis, index, count, shape) {
    const element = document.createElement("div");
    element.className = `layout-divider ${axis === "x" ? "column-divider" : "row-divider"}`;
    element.tabIndex = 0;
    element.setAttribute("role", "separator");
    element.setAttribute("aria-orientation", axis === "x" ? "vertical" : "horizontal");
    element.setAttribute("aria-label", kind === "map" ? "Resize map and videos"
      : `Resize video ${kind === "c" ? "columns" : "rows"} ${index + 1} and ${index + 2}`);
    element.setAttribute("aria-valuemin", "10");
    element.setAttribute("aria-valuemax", "90");
    const divider = { element, kind, axis, index, count, shape };
    this.dividers.push(divider);
    this.root.append(element);
    const resize = value => {
      const fraction = Math.min(0.9, Math.max(0.1, value));
      if (kind === "map") {
        this.state.sizing.mapFraction = fraction;
        this.applySplit(true, axis === "y");
      } else {
        const weights = [...this.weights(kind, count)];
        const pair = weights[index] + weights[index + 1];
        weights[index] = pair * fraction;
        weights[index + 1] = pair * (1 - fraction);
        this.state.sizing.tracks[kind + count] = weights;
        this.applyTracks(shape);
      }
      this.fitCameraTiles();
      this.positionDividers();
      this.redrawMap();
    };
    element.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      this.dragging = true;
      const rect = (kind === "map" ? this.root : this.videoGrid).getBoundingClientRect();
      const weights = this.weights(kind, count);
      const offset = kind === "map" ? 12
        : weights.slice(0, index).reduce((sum, weight) => sum + weight, 0)
          * ((axis === "x" ? rect.width : rect.height) - 8 * (count - 1)) + 8 * index;
      const extent = kind === "map" ? (axis === "x" ? rect.width : rect.height) - 32
        : (weights[index] + weights[index + 1])
          * ((axis === "x" ? rect.width : rect.height) - 8 * (count - 1));
      const move = event => {
        const coordinate = axis === "x" ? event.clientX - rect.left : event.clientY - rect.top;
        resize((coordinate - offset - 4) / Math.max(1, extent));
      };
      const finish = () => {
        element.removeEventListener("pointermove", move);
        element.removeEventListener("pointerup", finish);
        element.removeEventListener("pointercancel", finish);
        element.removeEventListener("lostpointercapture", finish);
        this.dragging = false;
        this.update();
        this.redrawMap();
      };
      element.addEventListener("pointermove", move);
      element.addEventListener("pointerup", finish);
      element.addEventListener("pointercancel", finish);
      element.addEventListener("lostpointercapture", finish);
    });
    element.addEventListener("keydown", event => {
      const decrease = axis === "x" ? "ArrowLeft" : "ArrowUp";
      const increase = axis === "x" ? "ArrowRight" : "ArrowDown";
      if (event.key !== decrease && event.key !== increase) return;
      event.preventDefault();
      const weights = this.weights(kind, count);
      const current = kind === "map" ? this.state.sizing.mapFraction
        : weights[index] / (weights[index] + weights[index + 1]);
      resize(current + (event.key === increase ? 0.05 : -0.05));
      this.update();
    });
  }

  positionDividers() {
    const root = this.root.getBoundingClientRect();
    const grid = this.videoGrid.getBoundingClientRect();
    for (const { element, kind, axis, index, count, shape } of this.dividers) {
      let left, top, width, height, fraction;
      if (kind === "map") {
        const map = this.mapPanel.getBoundingClientRect();
        fraction = this.state.sizing.mapFraction;
        left = axis === "x" ? map.right - root.left : 12;
        top = axis === "y" ? map.bottom - root.top : 12;
        width = axis === "x" ? 8 : root.width - 24;
        height = axis === "y" ? 8 : root.height - 24;
      } else {
        const weights = this.weights(kind, count);
        const before = weights.slice(0, index + 1).reduce((sum, weight) => sum + weight, 0);
        fraction = weights[index] / (weights[index] + weights[index + 1]);
        left = grid.left - root.left;
        top = grid.top - root.top;
        width = grid.width;
        height = grid.height;
        if (axis === "x") {
          left += before * (grid.width - 8 * (count - 1)) + 8 * index;
          width = 8;
          if (shape.trailingColumns > 1) {
            const rows = this.weights("r", shape.rows);
            height -= rows.at(-1) * (grid.height - 8 * (shape.rows - 1)) + 8;
          }
        } else {
          top += before * (grid.height - 8 * (count - 1)) + 8 * index;
          height = 8;
          if (shape.leadRows > 1) {
            const offset = this.weights("c", shape.columns)[0]
              * (grid.width - 8 * (shape.columns - 1)) + 8;
            left += offset;
            width -= offset;
          }
        }
      }
      Object.assign(element.style, {
        left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
      });
      element.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
    }
  }
}
