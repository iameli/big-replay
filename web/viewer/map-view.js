"use strict";

// Image pixels are the stable intermediate space; viewport changes never change calibration.
const MAP_SIZE = 4096;
const MAP_STORAGE = "big-walk:bigmap-4096:calibration:v1";

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
  constructor(canvas, redraw, pause) {
    this.canvas = canvas;
    this.redraw = redraw;
    this.points = [];
    this.transform = null;
    this.pending = null;
    this.zoom = 1;
    this.panX = this.panY = 0;
    this.sources = [];
    this.status = document.getElementById("alignment-status");
    this.sourceSelect = document.getElementById("anchor-source");
    this.placeButton = document.getElementById("place-anchor");
    this.image = new Image();
    this.image.onload = () => { this.ready = true; this.updateUI(); redraw(); };
    this.image.onerror = () => {
      this.status.textContent = "Map unavailable. Serve the repository root so ../../bigmap.jpeg is reachable.";
    };
    this.image.src = "../../bigmap.jpeg";
    try {
      const saved = JSON.parse(localStorage.getItem(MAP_STORAGE));
      if (Array.isArray(saved) && saved.length <= 3 && saved.every(p =>
        typeof p.label === "string" && [p.x, p.z, p.u, p.v].every(Number.isFinite) &&
        p.u >= 0 && p.u <= MAP_SIZE && p.v >= 0 && p.v <= MAP_SIZE)) {
        this.transform = solveCalibration(saved);
        this.points = saved;
      }
    } catch { /* Unavailable storage or obsolete/invalid calibration: start uncalibrated. */ }
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
      this.save();
    });
    document.getElementById("fit-map").addEventListener("click", () => {
      this.zoom = 1; this.panX = this.panY = 0; redraw();
    });
    this.bindPointer();
    this.updateUI();
  }

  save() {
    let persisted = true;
    try { localStorage.setItem(MAP_STORAGE, JSON.stringify(this.points)); } catch { persisted = false; }
    this.updateUI();
    if (!persisted) this.status.textContent += " Storage unavailable; alignment lasts only this session.";
    this.redraw();
  }

  updateUI() {
    this.status.textContent = this.pending
      ? `Click the map location of ${this.pending.label}. Drag to pan; click Cancel to stop.`
      : this.transform
        ? "Calibrated from 3 references · saved in this browser. Check a fourth known location."
        : `Uncalibrated · ${this.points.length}/3 references. Overlays appear after alignment.`;
    this.placeButton.textContent = this.pending ? "Cancel placement" : "Place reference";
    this.placeButton.disabled = !this.ready || !this.sources.length || this.points.length === 3;
    this.sourceSelect.disabled = !!this.pending;
    document.getElementById("undo-anchor").disabled = !this.points.length;
    document.getElementById("reset-alignment").disabled = !this.points.length && !this.pending;
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

  draw(ctx) {
    const { scale, ox, oy } = this.viewport();
    ctx.fillStyle = "#172e3a";
    ctx.fillRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    if (this.ready) ctx.drawImage(this.image, ox, oy, MAP_SIZE * scale, MAP_SIZE * scale);
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
      drag = { x, y, px: this.panX, py: this.panY, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", e => {
      const [x, y] = local(e);
      if (drag) {
        if (Math.hypot(x - drag.x, y - drag.y) > 4) drag.moved = true;
        if (drag.moved) {
          this.panX = drag.px + x - drag.x; this.panY = drag.py + y - drag.y;
          this.redraw();
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
      this.zoom = Math.min(16, Math.max(1, this.zoom * Math.exp(-e.deltaY * 0.001)));
      const [nx, ny] = this.imageToScreen(u, v);
      this.panX += x - nx; this.panY += y - ny;
      this.redraw();
    }, { passive: false });
  }
}
