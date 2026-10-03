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

function normalizeSavedLayouts(value) {
  if (!Array.isArray(value)) return [];
  const layouts = [];
  for (const candidate of value) {
    const name = typeof candidate?.name === "string" ? candidate.name.trim() : "";
    if (!name) continue;
    const layout = { name, selection: normalizePlaybackSelection(candidate.selection) };
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
  }

  setPlayerCount(playerCount) {
    this.playerCount = playbackPlayerCount(playerCount);
    this.selection = normalizePlaybackSelection(this.selection, this.playerCount);
  }

  setSelection(selection) {
    this.selection = normalizePlaybackSelection(selection, this.playerCount);
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
    return true;
  }

  addPlayer(index) {
    const key = playerLayoutKey(index);
    if (index < 0 || index >= this.playerCount || this.selection.includes(key)) return false;
    this.selection = PLAYBACK_LAYOUT_KEYS.filter(candidate =>
      candidate === key || this.selection.includes(candidate));
    return true;
  }

  save(name) {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) throw new Error("Enter a layout name.");
    const saved = { name: trimmed, selection: [...this.selection] };
    const existing = this.savedLayouts.findIndex(layout => layout.name === trimmed);
    if (existing >= 0) this.savedLayouts.splice(existing, 1);
    this.savedLayouts.push(saved);
    return saved;
  }

  recall(name) {
    const saved = this.savedLayouts.find(layout => layout.name === name);
    if (!saved) return false;
    this.setSelection(saved.selection);
    return true;
  }

  remove(name) {
    const index = this.savedLayouts.findIndex(layout => layout.name === name);
    if (index < 0) return false;
    this.savedLayouts.splice(index, 1);
    return true;
  }
}
