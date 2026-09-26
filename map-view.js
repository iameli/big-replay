"use strict";

// Image pixels are the stable intermediate space; viewport changes never change calibration.
const MAP_SIZE = 4096;
const MAP_STORAGE = "big-walk:bigmap-4096:calibration:v1";
const ROUTE_BLOCK_SIZE = 256;
const TRAIL_TILE_SIZE = 256; // Device pixels; the halo is cropped when compositing.
const TRAIL_CACHE_BYTES = 64 * 1024 * 1024;
// Aligned against the full train circuit on bigmap.jpeg.
const DEFAULT_MAP_TRANSFORM = Object.freeze({
  xx: 1.916268922611503,
  xz: 1.9229696648274224,
  yx: 1.9229696648274224,
  yz: -1.916268922611503,
  tx: 2671.7307720982303,
  ty: 619.7471474900055,
});

function solveCalibration(points) {
  if (points.length !== 3) return null;
  const [a, b, c] = points;
  const x1 = b.x - a.x, z1 = b.z - a.z, x2 = c.x - a.x, z2 = c.z - a.z;
  const u1 = b.u - a.u, v1 = b.v - a.v, u2 = c.u - a.u, v2 = c.v - a.v;
  const det = x1 * z2 - x2 * z1;
  const imageDet = u1 * v2 - u2 * v1;
  // Reject coincident/near-collinear triangles in either space rather than amplify click noise.
  if (Math.abs(det) < 0.001 * Math.max(1, Math.hypot(x1, z1) * Math.hypot(x2, z2)) ||
      Math.abs(imageDet) < 0.001 * Math.max(1, Math.hypot(u1, v1) * Math.hypot(u2, v2))) {
    throw new Error("Points are too close or nearly collinear. Use three widely separated locations forming a triangle.");
  }
  const xx = (u1 * z2 - u2 * z1) / det, xz = (u2 * x1 - u1 * x2) / det;
  const yx = (v1 * z2 - v2 * z1) / det, yz = (v2 * x1 - v1 * x2) / det;
  return { xx, xz, yx, yz, tx: a.u - xx * a.x - xz * a.z, ty: a.v - yx * a.x - yz * a.z };
}

class MapView {
  constructor(canvas, redraw, pause, playerColor, playerLabel) {
    this.canvas = canvas;
    this.redraw = redraw;
    this.playerColor = playerColor;
    this.playerLabel = playerLabel;
    this.points = [];
    this.transform = DEFAULT_MAP_TRANSFORM;
    this.pending = null;
    this.zoom = 1;
    this.panX = this.panY = 0;
    this.sources = [];
    this.routes = [];
    this.routeBounds = null;
    this.editing = null;
    this.showRoute = false;
    this.persisted = true;
    this.status = document.getElementById("alignment-status");
    this.sourceSelect = document.getElementById("anchor-source");
    this.placeButton = document.getElementById("place-anchor");
    this.image = new Image();
    this.image.onload = () => { this.ready = true; this.updateUI(); redraw(); };
    this.image.onerror = () => {
      this.status.textContent = "Map unavailable. Keep bigmap.jpeg beside index.html.";
    };
    this.image.src = "bigmap.jpeg";
    try {
      const saved = JSON.parse(localStorage.getItem(MAP_STORAGE));
      const points = Array.isArray(saved) ? saved : saved?.points;
      if (Array.isArray(points) && points.length <= 3 && points.every(p =>
        typeof p.label === "string" && [p.x, p.z, p.u, p.v].every(Number.isFinite) &&
        p.u >= 0 && p.u <= MAP_SIZE && p.v >= 0 && p.v <= MAP_SIZE)) {
        const t = points.length ? solveCalibration(points) : saved.transform;
        if (t && (![t.xx, t.xz, t.yx, t.yz, t.tx, t.ty].every(Number.isFinite) ||
            Math.abs(t.xx * t.yz - t.xz * t.yx) < 1e-12)) throw new Error("Invalid alignment");
        this.transform = t || null;
        this.points = points;
      }
    } catch { /* Unavailable storage or invalid calibration: keep the bundled alignment. */ }
    this.sourceSelect.addEventListener("focus", pause);
    this.placeButton.addEventListener("click", () => {
      if (this.pending) { this.pending = null; this.updateUI(); return; }
      const source = this.sources[this.sourceSelect.selectedIndex];
      if (!source) return;
      pause();
      this.pending = { ...source }; // Freeze coordinates at this exact replay frame.
      this.updateUI();
    });
    document.getElementById("undo-anchor").addEventListener("click", () => {
      this.pending = null;
      this.points.pop();
      this.transform = solveCalibration(this.points);
      this.save();
    });
    document.getElementById("reset-alignment").addEventListener("click", () => {
      this.pending = null;
      this.points = [];
      this.transform = null;
      this.showRoute = false;
      this.save();
    });
    document.getElementById("fit-map").addEventListener("click", () => {
      this.zoom = 1; this.panX = this.panY = 0; redraw();
    });
    this.bindRouteControls(pause);
    this.bindPointer();
    this.updateUI();
  }

  save() {
    this.persisted = true;
    try {
      localStorage.setItem(MAP_STORAGE, JSON.stringify({ points: this.points, transform: this.transform }));
    } catch { this.persisted = false; }
    this.updateUI();
    this.redraw();
  }

  updateUI() {
    this.status.textContent = this.editing
      ? "Adjusting full route · preview only. Match the track, then lock alignment."
      : this.pending
        ? `Click the map location of ${this.pending.label}. Drag to pan; click Cancel to stop.`
        : this.transform
          ? this.transform === DEFAULT_MAP_TRANSFORM
            ? "Alignment locked · bundled train-track calibration."
            : `Alignment locked${this.points.length ? " from 3 references" : ""} · ${this.persisted ? "saved in this browser" : "storage unavailable; this session only"}.`
          : `Uncalibrated · ${this.points.length}/3 references. Align the full route or place references.`;
    document.getElementById("route-editor").hidden = !this.editing;
    document.getElementById("reference-tools").hidden = !!this.editing;
    document.getElementById("align-route").disabled = !this.ready || !this.routeBounds || !!this.editing;
    document.getElementById("align-route").textContent = this.transform ? "Adjust full route" : "Align full route";
    const show = document.getElementById("show-route");
    show.disabled = !this.transform || !!this.editing;
    show.checked = this.showRoute;
    this.placeButton.textContent = this.pending ? "Cancel placement" : "Place reference";
    this.placeButton.disabled = !this.ready || !this.sources.length || this.points.length === 3;
    this.sourceSelect.disabled = !!this.pending;
    document.getElementById("undo-anchor").disabled = !this.points.length;
    document.getElementById("reset-alignment").disabled = !this.points.length && !this.pending && !this.transform;
    const list = document.getElementById("anchor-list");
    list.replaceChildren(...this.points.map((p, i) => {
      const li = document.createElement("li");
      li.textContent = `${i + 1}. ${p.label}: X ${p.x.toFixed(1)}, Z ${p.z.toFixed(1)} → ${p.u.toFixed(0)}, ${p.v.toFixed(0)} px`;
      return li;
    }));
    this.canvas.classList.toggle("placing", !!this.pending);
  }

  setSources(frame, landmarks) {
    const selected = this.sources[this.sourceSelect.selectedIndex]?.key;
    this.sources = [
      ...frame.players.map(p => ({ key: `p${p.netId}`, label: `${this.playerLabel(p.netId)} at ${frame.time.toFixed(2)}s`, x: p.x, z: p.z })),
      ...landmarks.map(l => ({ key: `l${l.id}`, label: `${l.label} (${l.id})`, x: l.x, z: l.z })),
      ...frame.gourds.map(g => ({ key: `g${g.name}`, label: `Gourd ${g.name}`, x: g.x, z: g.z })),
    ].filter(p => Number.isFinite(p.x) && Number.isFinite(p.z));
    this.sourceSelect.replaceChildren(...this.sources.map(p => new Option(p.label, p.key)));
    const index = this.sources.findIndex(p => p.key === selected);
    if (index >= 0) this.sourceSelect.selectedIndex = index;
    this.placeButton.disabled = !this.ready || !this.sources.length || this.points.length === 3;
  }

  setReplay(frames) {
    if (this.editing) this.cancelRoute();
    const routes = new Map();
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    // Cache geometry once. Every finite recorded position contributes; gaps do not join.
    frames.forEach((frame, index) => {
      for (const p of frame.players) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
        let route = routes.get(p.netId);
        if (!route) {
          route = { netId: p.netId, samples: [], tolerance: null };
          routes.set(p.netId, route);
        }
        route.samples.push([index, p.x, p.z]);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
    });
    this.routes = [...routes.values()];
    this.clearRasterCache();
    this.routeBounds = routes.size ? { minX, minZ, maxX, maxZ } : null;
    this.updateUI();
  }

  bindRouteControls(pause) {
    this.routeInputs = Object.fromEntries(
      ["scale", "angle", "offset-x", "offset-y", "width", "height", "shear", "flip-x", "flip-y"]
        .map(name => [name, document.getElementById(`route-${name}`)]));
    document.getElementById("align-route").addEventListener("click", () => {
      pause();
      this.beginRoute();
    });
    document.getElementById("cancel-route").addEventListener("click", () => this.cancelRoute());
    document.getElementById("lock-route").addEventListener("click", () => {
      if (!this.editing || !this.adjustRoute()) return;
      this.points = [];
      this.editing = null;
      this.save();
    });
    document.getElementById("show-route").addEventListener("change", e => {
      this.showRoute = e.target.checked;
      this.redraw();
    });
    for (const [name, input] of Object.entries(this.routeInputs)) {
      input.addEventListener("input", () => {
        const slider = document.getElementById(`route-${name}-range`);
        if (slider && input.validity.valid) slider.value = input.value;
        this.adjustRoute();
      });
    }
    for (const name of ["scale", "angle"]) {
      document.getElementById(`route-${name}-range`).addEventListener("input", e => {
        this.routeInputs[name].value = e.target.value;
        this.adjustRoute();
      });
    }
  }

  beginRoute() {
    if (!this.ready || !this.routeBounds || this.editing) return;
    const b = this.routeBounds;
    const x = (b.minX + b.maxX) / 2, z = (b.minZ + b.maxZ) / 2;
    const scale = MAP_SIZE * 0.65 / Math.max(1, b.maxX - b.minX, b.maxZ - b.minZ);
    // An initial preview, never a claimed geographic calibration.
    const base = this.transform || {
      xx: scale, xz: 0, yx: 0, yz: -scale,
      tx: MAP_SIZE / 2 - scale * x, ty: MAP_SIZE / 2 + scale * z,
    };
    this.editing = {
      previous: this.transform, showRoute: this.showRoute, base,
      u: base.xx * x + base.xz * z + base.tx,
      v: base.yx * x + base.yz * z + base.ty,
    };
    this.pending = null;
    this.transform = { ...base };
    this.showRoute = true;
    for (const [name, input] of Object.entries(this.routeInputs)) {
      if (input.type === "checkbox") input.checked = false;
      else input.value = ["scale", "width", "height"].includes(name) ? "100" : "0";
    }
    document.getElementById("route-scale-range").value = 100;
    document.getElementById("route-angle-range").value = 0;
    this.updateUI();
    this.redraw();
  }

  adjustRoute() {
    if (!this.editing) return false;
    const inputs = Object.values(this.routeInputs);
    const valid = inputs.every(input => input.type === "checkbox" ||
      (input.validity.valid && Number.isFinite(input.valueAsNumber)));
    document.getElementById("lock-route").disabled = !valid;
    if (!valid) return false;
    const number = name => this.routeInputs[name].valueAsNumber;
    const angle = number("angle") * Math.PI / 180;
    const scale = number("scale") / 100;
    const sx = scale * number("width") / 100 * (this.routeInputs["flip-x"].checked ? -1 : 1);
    const sy = scale * number("height") / 100 * (this.routeInputs["flip-y"].checked ? -1 : 1);
    const shear = number("shear") / 100;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const a = cos * sx, b = (cos * shear - sin) * sy;
    const c = sin * sx, d = (sin * shear + cos) * sy;
    const { base: t, u, v } = this.editing;
    this.transform = {
      xx: a * t.xx + b * t.yx, xz: a * t.xz + b * t.yz,
      yx: c * t.xx + d * t.yx, yz: c * t.xz + d * t.yz,
      tx: u + number("offset-x") + a * (t.tx - u) + b * (t.ty - v),
      ty: v + number("offset-y") + c * (t.tx - u) + d * (t.ty - v),
    };
    this.redraw();
    return true;
  }

  cancelRoute() {
    if (!this.editing) return;
    this.transform = this.editing.previous;
    this.showRoute = this.editing.showRoute;
    this.editing = null;
    document.getElementById("lock-route").disabled = false;
    this.updateUI();
    this.redraw();
  }

  viewport() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const scale = Math.min(w, h) / MAP_SIZE * this.zoom;
    return { scale, ox: (w - MAP_SIZE * scale) / 2 + this.panX, oy: (h - MAP_SIZE * scale) / 2 + this.panY };
  }

  imageToScreen(u, v) {
    const { scale, ox, oy } = this.viewport();
    return [ox + u * scale, oy + v * scale];
  }

  screenToImage(sx, sy) {
    const { scale, ox, oy } = this.viewport();
    return [(sx - ox) / scale, (sy - oy) / scale];
  }

  toScreen(x, z) {
    const t = this.transform;
    return this.imageToScreen(t.xx * x + t.xz * z + t.tx, t.yx * x + t.yz * z + t.ty);
  }

  imageToWorld(u, v) {
    const t = this.transform, det = t.xx * t.yz - t.xz * t.yx;
    u -= t.tx; v -= t.ty;
    return [(u * t.yz - v * t.xz) / det, (v * t.xx - u * t.yx) / det];
  }

  routeMatrix() {
    const { scale, ox, oy } = this.viewport(), t = this.transform;
    return new DOMMatrix([
      scale * t.xx, scale * t.yx, scale * t.xz, scale * t.yz,
      ox + scale * t.tx, oy + scale * t.ty,
    ]);
  }

  strokeRoute(ctx, route, matrix, color) {
    const path = new Path2D();
    path.addPath(route, matrix);
    ctx.save();
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.strokeStyle = "#10131a";
    ctx.lineWidth = 5;
    ctx.stroke(path);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.stroke(path);
    ctx.restore();
  }

  routeTolerance(matrix) {
    // Largest affine stretch: also bounds error for sheared/non-uniform alignments.
    const stretch = (Math.hypot(matrix.a + matrix.d, matrix.b - matrix.c) +
      Math.hypot(matrix.a - matrix.d, matrix.b + matrix.c)) / 2;
    // At most 1/4 CSS pixel of deviation; quantize so panning/small zooms reuse geometry.
    return 2 ** Math.floor(Math.log2(0.25 / stretch));
  }

  simplifiedPath(samples, start, end, tolerance) {
    const path = new Path2D(), stack = [];
    if (start >= end) return path;
    // Adjacent blocks share their boundary segment, but never bridge a missing frame.
    if (start > 0 && samples[start - 1][0] === samples[start][0] - 1) start--;
    const limit = tolerance * tolerance;
    while (start < end) {
      let last = start;
      while (last + 1 < end && samples[last + 1][0] === samples[last][0] + 1) last++;
      path.moveTo(samples[start][1], samples[start][2]);
      stack.push(start, last);
      // Iterative Ramer–Douglas–Peucker, bounded to one block rather than the whole run.
      while (stack.length) {
        const b = stack.pop(), a = stack.pop();
        const x = samples[a][1], z = samples[a][2];
        const dx = samples[b][1] - x, dz = samples[b][2] - z;
        const length = dx * dx + dz * dz;
        let farthest = -1, distance = limit;
        for (let i = a + 1; i < b; i++) {
          const px = samples[i][1] - x, pz = samples[i][2] - z;
          const t = length ? Math.max(0, Math.min(1, (px * dx + pz * dz) / length)) : 0;
          const ex = px - t * dx, ez = pz - t * dz, squared = ex * ex + ez * ez;
          if (squared > distance) { distance = squared; farthest = i; }
        }
        if (farthest < 0) path.lineTo(samples[b][1], samples[b][2]);
        else stack.push(farthest, b, a, farthest);
      }
      start = last + 1;
    }
    return path;
  }

  sampleEnd(samples, frameIndex) {
    let lo = 0, hi = samples.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (samples[mid][0] <= frameIndex) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  sampleBounds(samples, start, end) {
    if (start >= end) return null;
    if (start > 0 && samples[start - 1][0] === samples[start][0] - 1) start--;
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      bounds[0] = Math.min(bounds[0], samples[i][1]);
      bounds[1] = Math.min(bounds[1], samples[i][2]);
      bounds[2] = Math.max(bounds[2], samples[i][1]);
      bounds[3] = Math.max(bounds[3], samples[i][2]);
    }
    return bounds;
  }

  prepareRoute(route, tolerance) {
    if (route.tolerance === tolerance) return;
    route.tolerance = tolerance;
    route.blocks = [];
    for (let start = 0; start < route.samples.length; start += ROUTE_BLOCK_SIZE) {
      const end = Math.min(start + ROUTE_BLOCK_SIZE, route.samples.length);
      route.blocks.push({
        path: this.simplifiedPath(route.samples, start, end, tolerance),
        bounds: this.sampleBounds(route.samples, start, end),
      });
    }
  }

  recentPath(route, frameIndex) {
    const samples = route.samples, end = this.sampleEnd(samples, frameIndex);
    let start = end;
    while (start > 0 && samples[start - 1][0] >= frameIndex - 40) start--;
    const path = new Path2D();
    for (let i = start; i < end; i++) {
      const [, x, z] = samples[i];
      if (i === start || samples[i - 1][0] !== samples[i][0] - 1) path.moveTo(x, z);
      path.lineTo(x, z);
    }
    return path;
  }

  clearRasterCache() {
    const cache = this.rasterCache;
    if (!cache) return;
    for (const resource of cache.resources.keys()) {
      for (const canvas of resource.canvases) canvas.width = canvas.height = 0;
    }
    if (cache.scene) cache.scene.width = cache.scene.height = 0;
    cache.scratch.width = cache.scratch.height = 0;
    this.rasterCache = null;
  }

  // Only raster storage is budgeted here. Geometry contains recorded coordinates/paths,
  // never viewport-sized player bitmaps. Evicted masks reconstruct from the tile index.
  rasterResource(cache, width, height, count, owner, key, pinned) {
    const bytes = width * height * 4 * count;
    while (cache.bytes + bytes > TRAIL_CACHE_BYTES) {
      let victim;
      for (const resource of cache.resources.keys()) {
        if (resource === pinned) continue;
        if (!victim) victim = resource;
        // Valid output pixels remain useful even after their history masks go cold.
        if (resource.owner !== cache.outputs) { victim = resource; break; }
      }
      if (!victim) return null;
      cache.resources.delete(victim);
      victim.owner.delete(victim.key);
      cache.bytes -= victim.bytes;
      if (victim.owner === cache.outputs) {
        for (const state of cache.states) {
          if (!state.masks.has(victim.key)) state.tileBlocks.delete(victim.key);
        }
      } else if (!cache.outputs.has(victim.key)) {
        for (const state of cache.states) {
          if (victim.owner === state.masks) state.tileBlocks.delete(victim.key);
        }
      }
      for (const canvas of victim.canvases) canvas.width = canvas.height = 0;
    }
    const resource = {
      canvases: Array.from({ length: count }, () => new OffscreenCanvas(width, height)),
      bytes, owner, key,
    };
    cache.bytes += bytes;
    cache.resources.set(resource, true);
    owner.set(key, resource);
    return resource;
  }

  touchRaster(cache, resource) {
    cache.resources.delete(resource);
    cache.resources.set(resource, true);
  }

  rasterBounds(cache, bounds, matrix) {
    if (!bounds) return null;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const x of [bounds[0], bounds[2]]) {
      for (const z of [bounds[1], bounds[3]]) {
        const sx = (matrix.a * x + matrix.c * z + matrix.e) * cache.rx;
        const sy = (matrix.b * x + matrix.d * z + matrix.f) * cache.ry;
        left = Math.min(left, sx); right = Math.max(right, sx);
        top = Math.min(top, sy); bottom = Math.max(bottom, sy);
      }
    }
    // Outputs include a halo too: cover both that padding and the stroke radius.
    const pad = 2 * cache.halo;
    return [left - pad, top - pad, right + pad, bottom + pad];
  }

  tileIntersects(tile, bounds) {
    return bounds && bounds[0] <= tile.x + tile.width && bounds[2] >= tile.x &&
      bounds[1] <= tile.y + tile.height && bounds[3] >= tile.y;
  }

  blocksForTile(state, tile) {
    let blocks = state.tileBlocks.get(tile.id);
    if (!blocks) {
      blocks = [];
      for (let i = 0; i < state.blockBounds.length; i++) {
        if (this.tileIntersects(tile, state.blockBounds[i])) blocks.push(i);
      }
      state.tileBlocks.set(tile.id, blocks);
    }
    return blocks;
  }

  dirtyRasterBounds(cache, bounds) {
    if (!bounds) return;
    // Never enumerate the global grid. Only resident outputs and the current scene
    // can become stale; a cold tile reconstructs at the current replay cutoff.
    for (const output of cache.outputs.values()) {
      if (this.tileIntersects(output.tile, bounds)) output.dirty = true;
    }
    for (const tile of cache.tiles) {
      if (this.tileIntersects(tile, bounds)) cache.dirty.add(tile.id);
    }
  }

  rasterState(route, cache, matrix) {
    this.prepareRoute(route, this.routeTolerance(matrix));
    return {
      route, end: 0, complete: 0, live: null, liveBounds: null,
      blockBounds: route.blocks.map(block => this.rasterBounds(cache, block.bounds, matrix)),
      tileBlocks: new Map(), paths: [], masks: new Map(),
    };
  }

  updateRasterState(state, end, cache, matrix, full) {
    const samples = state.route.samples;
    const complete = full ? state.route.blocks.length : Math.floor(end / ROUTE_BLOCK_SIZE);
    if (end === state.end && complete === state.complete) return;
    // Repeating a contiguous stationary endpoint cannot change RDP's polyline.
    // Keep its pixels (and mutable path) rather than dirtying a parked player.
    if (complete === state.complete && end > state.end && state.end > 0) {
      let stationary = true;
      for (let i = state.end; i < end; i++) {
        const a = samples[i - 1], b = samples[i];
        if (a[0] + 1 !== b[0] || a[1] !== b[1] || a[2] !== b[2]) {
          stationary = false; break;
        }
      }
      if (stationary) { state.end = end; return; }
    }
    this.dirtyRasterBounds(cache, state.liveBounds);
    for (let i = state.complete; i < complete; i++) {
      this.dirtyRasterBounds(cache, state.blockBounds[i]);
    }
    state.end = end;
    state.complete = complete;
    state.live = null;
    state.liveBounds = null;
    if (!full && end % ROUTE_BLOCK_SIZE) {
      const start = complete * ROUTE_BLOCK_SIZE;
      state.live = new Path2D();
      state.live.addPath(this.simplifiedPath(samples, start, end, state.route.tolerance), matrix);
      state.liveBounds = this.rasterBounds(cache, this.sampleBounds(samples, start, end), matrix);
      this.dirtyRasterBounds(cache, state.liveBounds);
    }
  }

  rasterKey(mode, rx, ry) {
    const { scale } = this.viewport(), t = this.transform;
    return JSON.stringify([
      this.canvas.width, this.canvas.height, this.canvas.clientWidth, this.canvas.clientHeight,
      rx, ry, scale, t && [t.xx, t.xz, t.yx, t.yz, t.tx, t.ty],
      !!this.ready, mode, !!this.editing,
      this.routes.map(route => this.playerColor(route.netId)),
      this.points.map(point => [point.u, point.v]),
    ]);
  }

  getRasterCache(mode, frameIndex, matrix,
    rx = this.canvas.width / this.canvas.clientWidth, ry = this.canvas.height / this.canvas.clientHeight) {
    const key = this.rasterKey(mode, rx, ry);
    let cache = this.rasterCache;
    if (cache && (cache.key !== key || (mode === "persistent" && frameIndex < cache.frame))) {
      this.clearRasterCache();
      cache = null;
    }
    if (!cache) {
      const width = this.canvas.width, height = this.canvas.height;
      const halo = Math.ceil(2.5 * Math.max(rx, ry)) + 1;
      const side = TRAIL_TILE_SIZE + 2 * halo, scratchBytes = side * side * 4;
      if (!width || !height || !(rx > 0 && ry > 0) || !Number.isFinite(scratchBytes) ||
          scratchBytes * 5 > TRAIL_CACHE_BYTES) return null;
      const { scale } = this.viewport(), t = this.transform;
      const anchored = matrix && new DOMMatrix([
        matrix.a, matrix.b, matrix.c, matrix.d, scale * t.tx, scale * t.ty,
      ]);
      cache = {
        key, rx, ry, halo, side, width, height, frame: frameIndex, matrix: anchored,
        columns: Math.ceil(width / TRAIL_TILE_SIZE) + 2,
        rows: Math.ceil(height / TRAIL_TILE_SIZE) + 2,
        resources: new Map(), outputs: new Map(), dirty: new Set(), states: [], tiles: [],
        scratch: new OffscreenCanvas(side, side), bytes: scratchBytes, scene: null,
      };
      // Compose integer-aligned tile cores, then translate this one scene bitmap.
      // The extra grid cells keep fractional sampling away from its outer edges.
      const sceneWidth = cache.columns * TRAIL_TILE_SIZE, sceneHeight = cache.rows * TRAIL_TILE_SIZE;
      const sceneBytes = sceneWidth * sceneHeight * 4;
      if (sceneBytes <= TRAIL_CACHE_BYTES / 2 && sceneBytes + 5 * scratchBytes <= TRAIL_CACHE_BYTES) {
        cache.scene = new OffscreenCanvas(sceneWidth, sceneHeight);
        cache.bytes += sceneBytes;
      }
      if (anchored && (mode === "persistent" || mode === "full")) {
        cache.states = this.routes.map(route => this.rasterState(route, cache, anchored));
      }
      this.rasterCache = cache;
    }
    const { ox, oy } = this.viewport();
    cache.offsetX = ox * rx;
    cache.offsetY = oy * ry;
    const sceneX = Math.floor((-cache.offsetX - 1) / TRAIL_TILE_SIZE) * TRAIL_TILE_SIZE;
    const sceneY = Math.floor((-cache.offsetY - 1) / TRAIL_TILE_SIZE) * TRAIL_TILE_SIZE;
    if (cache.sceneX !== sceneX || cache.sceneY !== sceneY) {
      cache.sceneX = sceneX; cache.sceneY = sceneY;
      cache.tiles = [];
      cache.dirty.clear();
      for (let row = 0; row < cache.rows; row++) {
        for (let column = 0; column < cache.columns; column++) {
          const x = sceneX + column * TRAIL_TILE_SIZE, y = sceneY + row * TRAIL_TILE_SIZE;
          const id = `${x / TRAIL_TILE_SIZE},${y / TRAIL_TILE_SIZE}`;
          cache.tiles.push({ id, x, y, width: TRAIL_TILE_SIZE, height: TRAIL_TILE_SIZE });
          cache.dirty.add(id);
        }
      }
    }
    cache.frame = frameIndex;
    for (const state of cache.states) {
      this.updateRasterState(state, mode === "full" ? state.route.samples.length :
        this.sampleEnd(state.route.samples, frameIndex), cache, cache.matrix, mode === "full");
    }
    return cache;
  }

  completedTilePath(state, blocks, start, matrix) {
    const path = new Path2D();
    for (const index of blocks) {
      if (index >= state.complete) break;
      if (index < start) continue;
      if (!state.paths[index]) {
        state.paths[index] = new Path2D();
        state.paths[index].addPath(state.route.blocks[index].path, matrix);
      }
      path.addPath(state.paths[index]);
    }
    return path;
  }

  tileHistory(cache, state, tile, matrix, pinned) {
    const blocks = this.blocksForTile(state, tile);
    if (!blocks.length || blocks[0] >= state.complete) return null;
    let resource = state.masks.get(tile.id);
    if (!resource) {
      resource = this.rasterResource(cache, cache.side, cache.side, 3, state.masks, tile.id, pinned);
      if (!resource) return null;
      resource.complete = 0;
    }
    this.touchRaster(cache, resource);
    if (resource.complete === state.complete) return resource;
    const path = this.completedTilePath(state, blocks, resource.complete, matrix);
    for (let index = 0; index < 2; index++) {
      const ctx = resource.canvases[index].getContext("2d");
      ctx.setTransform(cache.rx, 0, 0, cache.ry, cache.halo - tile.x, cache.halo - tile.y);
      ctx.lineJoin = ctx.lineCap = "round";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = index ? 2.5 : 5;
      ctx.stroke(path);
    }
    resource.complete = state.complete;
    return resource;
  }

  drawMap(ctx) {
    const { scale, ox, oy } = this.viewport();
    ctx.fillStyle = "#172e3a";
    ctx.fillRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    if (this.ready) ctx.drawImage(this.image, ox, oy, MAP_SIZE * scale, MAP_SIZE * scale);
  }

  drawReferences(ctx, anchored = false) {
    if (this.editing) return;
    const { scale, ox, oy } = this.viewport();
    for (let i = 0; i < this.points.length; i++) {
      const x = this.points[i].u * scale + (anchored ? 0 : ox);
      const y = this.points[i].v * scale + (anchored ? 0 : oy);
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#10131a"; ctx.fillRect(x + 10, y - 11, 15, 17);
      ctx.fillStyle = "#fff"; ctx.font = "12px system-ui"; ctx.fillText(String(i + 1), x + 14, y + 2);
    }
  }

  paintTrailTile(cache, tile, target, matrix, mode, pinned) {
    const ctx = target.getContext("2d");
    const { scale } = this.viewport();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#172e3a";
    ctx.fillRect(0, 0, cache.side, cache.side);
    ctx.setTransform(cache.rx, 0, 0, cache.ry, cache.halo - tile.x, cache.halo - tile.y);
    if (this.ready) ctx.drawImage(this.image, 0, 0, MAP_SIZE * scale, MAP_SIZE * scale);
    if (mode !== "full") this.drawReferences(ctx, true);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const scratch = cache.scratch.getContext("2d");
    for (const state of cache.states) {
      const history = this.tileHistory(cache, state, tile, matrix, pinned);
      const live = this.tileIntersects(tile, state.liveBounds) ? state.live : null;
      if (!history && !live) continue;
      // Other players often stand still while one player's mutable tail changes.
      // Reuse their already-colored tile instead of tinting both masks every frame.
      if (history && history.paintedComplete === history.complete && history.paintedLive === live) {
        ctx.drawImage(history.canvases[2], 0, 0);
        continue;
      }
      const player = history?.canvases[2].getContext("2d");
      if (player) player.clearRect(0, 0, cache.side, cache.side);
      // Union the completed and mutable masks BEFORE applying each color. Painting
      // outline/fill block-by-block would blacken older colored self-intersections.
      for (let pass = 0; pass < 2; pass++) {
        scratch.setTransform(1, 0, 0, 1, 0, 0);
        scratch.clearRect(0, 0, cache.side, cache.side);
        if (history) scratch.drawImage(history.canvases[pass], 0, 0);
        if (live) {
          scratch.setTransform(cache.rx, 0, 0, cache.ry, cache.halo - tile.x, cache.halo - tile.y);
          scratch.lineJoin = scratch.lineCap = "round";
          scratch.lineWidth = pass ? 2.5 : 5;
          scratch.strokeStyle = "#fff";
          scratch.stroke(state.live);
          scratch.setTransform(1, 0, 0, 1, 0, 0);
        }
        scratch.globalCompositeOperation = "source-in";
        scratch.fillStyle = pass ? (this.editing ? "#ff70da" : this.playerColor(state.route.netId)) : "#10131a";
        scratch.fillRect(0, 0, cache.side, cache.side);
        scratch.globalCompositeOperation = "source-over";
        if (player) player.drawImage(cache.scratch, 0, 0);
        else ctx.drawImage(cache.scratch, 0, 0);
      }
      if (history) {
        history.paintedComplete = history.complete;
        history.paintedLive = live;
        ctx.drawImage(history.canvases[2], 0, 0);
      }
    }
    if (mode === "full") {
      ctx.setTransform(cache.rx, 0, 0, cache.ry, cache.halo - tile.x, cache.halo - tile.y);
      this.drawReferences(ctx, true);
    }
    ctx.restore();
  }

  drawRasterCache(ctx, cache, mode) {
    const scene = cache.scene?.getContext("2d");
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const tile of cache.tiles) {
      if (scene && !cache.dirty.has(tile.id)) continue;
      let output = cache.outputs.get(tile.id);
      if (!output) {
        output = this.rasterResource(cache, cache.side, cache.side, 1, cache.outputs, tile.id);
        output.tile = tile;
        output.dirty = true;
      }
      this.touchRaster(cache, output);
      if (output.dirty) {
        this.paintTrailTile(cache, tile, output.canvases[0], cache.matrix, mode, output);
        output.dirty = false;
      }
      cache.dirty.delete(tile.id);
      if (scene) {
        scene.drawImage(output.canvases[0], cache.halo, cache.halo, tile.width, tile.height,
          tile.x - cache.sceneX, tile.y - cache.sceneY, tile.width, tile.height);
      } else {
        // Each destination pixel belongs to exactly one integer-aligned clip. Its
        // fractional source sample can still read the neighboring padded pixels.
        const x = tile.x + cache.offsetX, y = tile.y + cache.offsetY;
        ctx.save();
        ctx.beginPath();
        ctx.rect(Math.floor(x), Math.floor(y), tile.width, tile.height);
        ctx.clip();
        ctx.drawImage(output.canvases[0], x - cache.halo, y - cache.halo);
        ctx.restore();
      }
    }
    if (scene) ctx.drawImage(cache.scene, cache.sceneX + cache.offsetX, cache.sceneY + cache.offsetY);
    ctx.restore();
  }

  draw(ctx, frameIndex, trailMode) {
    const mode = !this.transform ? "off" : this.showRoute ? "full" : trailMode;
    const matrix = this.transform ? this.routeMatrix() : null;
    const backing = ctx.getTransform();
    const cache = this.getRasterCache(mode, frameIndex, matrix, backing.a, backing.d);
    if (cache) {
      this.drawRasterCache(ctx, cache, mode);
    } else {
      // Degenerate/extraordinary backing sizes still render correctly without allocating
      // a bitmap larger than the budget. Normal/high-DPR viewports use the paths above.
      this.drawMap(ctx);
      if (mode !== "full") this.drawReferences(ctx);
      if (mode === "persistent" || mode === "full") {
        for (const route of this.routes) {
          this.prepareRoute(route, this.routeTolerance(matrix));
          const end = mode === "full" ? route.samples.length : this.sampleEnd(route.samples, frameIndex);
          const path = new Path2D(), complete = Math.floor(end / ROUTE_BLOCK_SIZE);
          for (let i = 0; i < complete; i++) path.addPath(route.blocks[i].path);
          if (end % ROUTE_BLOCK_SIZE) path.addPath(this.simplifiedPath(route.samples,
            complete * ROUTE_BLOCK_SIZE, end, route.tolerance));
          this.strokeRoute(ctx, path, matrix, this.editing ? "#ff70da" : this.playerColor(route.netId));
        }
      }
      if (mode === "full") this.drawReferences(ctx);
    }
    if (mode === "recent") {
      for (const route of this.routes) {
        this.strokeRoute(ctx, this.recentPath(route, frameIndex), matrix, this.playerColor(route.netId));
      }
    }
  }

  bindPointer() {
    const canvas = this.canvas;
    let drag = null;
    const local = e => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    canvas.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      const [x, y] = local(e);
      drag = {
        x, y, px: this.panX, py: this.panY, moved: false,
        editing: this.editing && !e.shiftKey ? this.editing : null,
        scale: this.viewport().scale,
        offsetX: this.routeInputs["offset-x"].valueAsNumber,
        offsetY: this.routeInputs["offset-y"].valueAsNumber,
      };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", e => {
      const [x, y] = local(e);
      if (drag) {
        if (Math.hypot(x - drag.x, y - drag.y) > 4) drag.moved = true;
        if (drag.moved) {
          if (drag.editing) {
            if (this.editing !== drag.editing) { drag = null; return; }
            this.routeInputs["offset-x"].value = (drag.offsetX + (x - drag.x) / drag.scale).toFixed(2);
            this.routeInputs["offset-y"].value = (drag.offsetY + (y - drag.y) / drag.scale).toFixed(2);
            this.adjustRoute();
          } else {
            this.panX = drag.px + x - drag.x; this.panY = drag.py + y - drag.y;
            this.redraw();
          }
        }
      }
      const [u, v] = this.screenToImage(x, y);
      let text = `Image ${u.toFixed(1)}, ${v.toFixed(1)} px`;
      if (this.transform) {
        const [wx, wz] = this.imageToWorld(u, v);
        text += ` · World X ${wx.toFixed(2)}, Z ${wz.toFixed(2)}`;
      }
      document.getElementById("coordinates").textContent = text;
    });
    canvas.addEventListener("pointerup", e => {
      if (!drag) return;
      const clicked = !drag.moved;
      drag = null;
      canvas.releasePointerCapture(e.pointerId);
      if (!clicked || !this.pending) return;
      const [u, v] = this.screenToImage(...local(e));
      if (u < 0 || v < 0 || u > MAP_SIZE || v > MAP_SIZE) {
        this.status.textContent = "Click inside the map image, not the surrounding margin.";
        return;
      }
      const point = { ...this.pending, u, v };
      if (this.points.some(p => Math.hypot(p.x - point.x, p.z - point.z) < 1)) {
        this.status.textContent = "That world position is already a reference. Cancel and choose a different location.";
        return;
      }
      try {
        const points = [...this.points, point];
        const transform = solveCalibration(points);
        this.points = points; this.transform = transform; this.pending = null;
        this.save();
      } catch (err) { this.status.textContent = err.message; }
    });
    canvas.addEventListener("pointercancel", () => { drag = null; });
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      const [x, y] = local(e), [u, v] = this.screenToImage(x, y);
      // Chromium reports trackpad pinch as small Ctrl+wheel deltas.
      const sensitivity = e.ctrlKey ? 0.01 : 0.001;
      this.zoom = Math.min(16, Math.max(1, this.zoom * Math.exp(-e.deltaY * sensitivity)));
      const [nx, ny] = this.imageToScreen(u, v);
      this.panX += x - nx; this.panY += y - ny;
      this.redraw();
    }, { passive: false });
  }
}
