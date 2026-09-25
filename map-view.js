"use strict";

// Image pixels are the stable intermediate space; viewport changes never change calibration.
const MAP_SIZE = 4096;
const MAP_STORAGE = "big-walk:bigmap-4096:calibration:v1";
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
  constructor(canvas, redraw, pause, playerColor) {
    this.canvas = canvas;
    this.redraw = redraw;
    this.playerColor = playerColor;
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
      ...frame.players.map(p => ({ key: `p${p.netId}`, label: `Player #${p.netId} at ${frame.time.toFixed(2)}s`, x: p.x, z: p.z })),
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
          route = {
            netId: p.netId, path: new Path2D(), lastFrame: -2, samples: [],
            history: new Path2D(), historyEnd: 0,
          };
          routes.set(p.netId, route);
        }
        if (route.lastFrame === index - 1) route.path.lineTo(p.x, p.z);
        else {
          route.path.moveTo(p.x, p.z);
          route.path.lineTo(p.x, p.z);
        }
        route.lastFrame = index;
        route.samples.push([index, p.x, p.z]);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
    });
    this.routes = [...routes.values()];
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

  appendSamples(path, samples, start, end) {
    for (let i = start; i < end; i++) {
      const [frame, x, z] = samples[i];
      if (i > 0 && samples[i - 1][0] === frame - 1) path.lineTo(x, z);
      else { path.moveTo(x, z); path.lineTo(x, z); }
    }
  }

  drawTrails(ctx, frameIndex, mode) {
    if (mode === "off" || this.showRoute) return;
    const matrix = this.routeMatrix();
    for (const route of this.routes) {
      const samples = route.samples;
      // Find the current prefix without scanning the entire recording each render.
      let lo = 0, hi = samples.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (samples[mid][0] <= frameIndex) lo = mid + 1;
        else hi = mid;
      }
      const end = lo;
      let path;
      if (mode === "persistent") {
        if (end < route.historyEnd) {
          route.history = new Path2D();
          route.historyEnd = 0;
        }
        this.appendSamples(route.history, samples, route.historyEnd, end);
        route.historyEnd = end;
        path = route.history;
      } else {
        let start = end;
        while (start > 0 && samples[start - 1][0] >= frameIndex - 40) start--;
        path = new Path2D();
        if (start < end) {
          path.moveTo(samples[start][1], samples[start][2]);
          this.appendSamples(path, samples, start, end);
        }
      }
      this.strokeRoute(ctx, path, matrix, this.playerColor(route.netId));
    }
  }

  draw(ctx) {
    const { scale, ox, oy } = this.viewport();
    ctx.fillStyle = "#172e3a";
    ctx.fillRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    if (this.ready) ctx.drawImage(this.image, ox, oy, MAP_SIZE * scale, MAP_SIZE * scale);
    if (this.transform && this.showRoute) {
      const matrix = this.routeMatrix();
      for (const route of this.routes) {
        this.strokeRoute(ctx, route.path, matrix, this.editing ? "#ff70da" : this.playerColor(route.netId));
      }
    }
    if (this.editing) return;
    for (let i = 0; i < this.points.length; i++) {
      const [x, y] = this.imageToScreen(this.points[i].u, this.points[i].v);
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#10131a"; ctx.fillRect(x + 10, y - 11, 15, 17);
      ctx.fillStyle = "#fff"; ctx.font = "12px system-ui"; ctx.fillText(String(i + 1), x + 14, y + 2);
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
