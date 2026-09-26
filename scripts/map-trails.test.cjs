const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

// Geometry and cache lifecycle only: native Canvas pixel checks cover compositing.
class RecordedPath {
  constructor() { this.commands = []; }
  moveTo(x, z) { this.commands.push(['M', x, z]); }
  lineTo(x, z) { this.commands.push(['L', x, z]); }
  addPath(path) { this.commands.push(...path.commands); }
}
class Bitmap {
  constructor(width, height) { this.width = width; this.height = height; }
}
const MapView = runInNewContext(
  readFileSync(join(__dirname, '../map-view.js'), 'utf8') + '\nMapView',
  { Path2D: RecordedPath, OffscreenCanvas: Bitmap });
const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const samples = Array.from({ length: 800 }, (_, i) => [
  i + (i >= 130 ? 6 : 0) + (i >= 520 ? 4 : 0),
  i, Math.sin(i / 31) * .1 + (i % 100 === 50 ? 3 : 0),
]);
function makeView(positions = samples) {
  const view = Object.create(MapView.prototype);
  view.canvas = { width: 1024, height: 768, clientWidth: 1024, clientHeight: 768 };
  view.routes = [{ netId: 1, samples: positions, tolerance: null }];
  view.transform = { xx: 1, xz: 0, yx: 0, yz: 1, tx: 0, ty: 0 };
  view.points = [];
  view.zoom = 1;
  view.panX = view.panY = 0;
  view.playerColor = () => '#fff';
  view.updateUI = () => {};
  return view;
}
function statePath(state) {
  const path = new RecordedPath();
  for (let i = 0; i < state.complete; i++) path.addPath(state.route.blocks[i].path);
  if (state.live) path.addPath(state.live);
  return path;
}
function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], length = dx * dx + dz * dz;
  const t = length ? Math.max(0, Math.min(1,
    ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / length)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}
function checkPath(path, end, matrix = identity) {
  const project = (x, z) => [matrix.a * x + matrix.c * z + matrix.e,
    matrix.b * x + matrix.d * z + matrix.f];
  let previous;
  for (const [op, x, z] of path.commands) {
    assert.ok(x < end, 'future samples must not appear in a trail');
    if (op === 'L' && previous) {
      const a = project(...previous), b = project(x, z);
      for (let i = previous[0]; i <= x; i++) {
        if (i > previous[0]) assert.equal(samples[i][0], samples[i - 1][0] + 1,
          'a line must not bridge missing frames');
        assert.ok(distanceToSegment(project(samples[i][1], samples[i][2]), a, b) <= .250001,
          'simplification must stay within a quarter CSS pixel');
      }
    }
    previous = [x, z];
  }
  if (end) assert.deepEqual(path.commands.at(-1).slice(1), samples[end - 1].slice(1),
    'the current endpoint must remain exact');
  else assert.equal(path.commands.length, 0, 'no trail before the first sample');
}

test('tile geometry respects cutoffs, gaps, and backward seeks across block boundaries', () => {
  const view = makeView();
  for (const frame of [-1, 0, 129, 130, 135, 136, 260, 261, 262, 517, 518,
    529, 809, 539, 530, 525, 262, 261, 260, 8, 808]) {
    const cache = view.getRasterCache('persistent', frame, identity);
    const next = samples.findIndex(p => p[0] > frame);
    checkPath(statePath(cache.states[0]), next < 0 ? samples.length : next);
  }
});

test('zoom, reflection, and sheared alignment retain the screen-space error bound', () => {
  const view = makeView();
  for (const [a, b, c, d] of [[.66, 0, 0, .66], [16, 0, 0, 16],
    [1.7, .3, 2.2, .8], [-1.5, .7, -.4, 1.2], [.01, 0, 0, .02]]) {
    const matrix = { a, b, c, d, e: 10, f: -4 };
    view.clearRasterCache();
    for (const end of [800, 519, 256, 255, 1, 799]) {
      const cache = view.getRasterCache('persistent', samples[end - 1][0], matrix);
      checkPath(statePath(cache.states[0]), end, matrix);
    }
  }
});

test('recent trails exclude older history after switching from persistent mode', () => {
  const view = makeView();
  const old = view.getRasterCache('persistent', 809, identity);
  const recent = view.getRasterCache('recent', 140, identity);
  assert.notEqual(recent, old);
  assert.equal(old.scene.width, 0, 'obsolete pixels must be released');
  const path = view.recentPath(view.routes[0], 140);
  checkPath(path, samples.findIndex(p => p[0] > 140));
  for (const [, x] of path.commands) assert.ok(samples[x][0] >= 100,
    'recent trails may contain only the last 40 frame intervals');
});

test('loading another replay releases old pixels and breaks lines at invalid positions', () => {
  const view = makeView();
  const old = view.getRasterCache('persistent', 809, identity);
  view.setReplay([
    { players: [{ netId: 7, x: 10, z: 20 }] },
    { players: [{ netId: 7, x: NaN, z: 20 }] },
    { players: [] },
    { players: [{ netId: 7, x: 30, z: 40 }] },
    { players: [{ netId: 7, x: 30, z: 40 }] },
  ]);
  assert.equal(old.scene.width, 0);
  assert.equal(view.routes.length, 1);
  assert.equal(view.routes[0].netId, 7);
  const path = statePath(view.getRasterCache('persistent', 4, identity).states[0]);
  const dots = new Set();
  let previous;
  for (const [op, x, z] of path.commands) {
    if (op === 'L') {
      assert.deepEqual([x, z], previous, 'isolated stationary positions must not be connected');
      dots.add(`${x},${z}`);
    }
    previous = [x, z];
  }
  assert.deepEqual(dots, new Set(['10,20', '30,40']));
});

test('mutable RDP revisions replace old geometry and dirty both old and new tile coverage', () => {
  const view = makeView([[0, 0, 10], [1, 200, 10.2], [2, 400, 10.4], [3, 600, 10]]);
  const cache = view.getRasterCache('persistent', 2, identity), state = cache.states[0];
  const oldPath = state.live, oldTiles = [...state.liveTiles];
  assert.ok(!oldPath.commands.some(([, x]) => x === 200), 'first prefix simplifies to one segment');
  cache.dirty.clear();
  view.getRasterCache('persistent', 3, identity);
  assert.notEqual(state.live, oldPath);
  assert.ok(state.live.commands.some(([, x]) => x === 400), 'the new endpoint revises earlier geometry');
  for (const id of [...oldTiles, ...state.liveTiles]) assert.ok(cache.dirty.has(id));
  assert.equal(state.complete, 0, 'a mutable prefix must never enter immutable history');
});

test('ordinary playback dirties only affected tiles and stationary extensions keep pixels', () => {
  const positions = Array.from({ length: 300 }, (_, i) => [i, i < 256 ? 20 : 600, 20]);
  positions[257] = [257, 610, 20];
  for (let i = 258; i < positions.length; i++) positions[i] = [i, 610, 20];
  const view = makeView(positions), cache = view.getRasterCache('persistent', 256, identity);
  cache.dirty.clear();
  view.getRasterCache('persistent', 257, identity);
  assert.deepEqual([...cache.dirty].sort(), [0, 1, 2], 'the live boundary segment spans three tiles');
  cache.dirty.clear();
  const live = cache.states[0].live;
  view.getRasterCache('persistent', 298, identity);
  assert.equal(cache.dirty.size, 0);
  assert.equal(cache.states[0].live, live);
  assert.equal(cache.states[0].end, 299, 'stationary playback still advances the cutoff');
});

test('spatial indexing retains crossing segments, boundary halos, and affine placement', () => {
  const view = makeView(), cache = view.getRasterCache('off', 0, null);
  assert.deepEqual(Array.from(view.tilesForBounds(cache, [255, 20, 255, 30], identity)), [0, 1]);
  assert.deepEqual(Array.from(view.tilesForBounds(cache, [-100, 20, 1100, 30], identity)), [0, 1, 2, 3]);
  assert.deepEqual(Array.from(view.tilesForBounds(cache, [-100, -100, -20, -20], identity)), []);
  const reflected = { a: -1, b: 0, c: 0, d: 1, e: 768, f: 0 };
  assert.deepEqual(Array.from(view.tilesForBounds(cache, [10, 10, 30, 30], reflected)), [2]);
  const route = { netId: 2, tolerance: null, samples: Array.from({ length: 768 }, (_, i) =>
    [i + Math.floor(i / 256), Math.floor(i / 256) * 300 + 20, 20]) };
  const state = view.rasterState(route, cache, identity);
  assert.deepEqual(Array.from(state.tileBlocks.get(0)), [0]);
  assert.deepEqual(Array.from(state.tileBlocks.get(1)), [1]);
  assert.deepEqual(Array.from(state.tileBlocks.get(2)), [2]);
  view.updateRasterState(state, 256, cache, identity, false);
  assert.equal(view.completedTilePath(state, state.tileBlocks.get(1), 0, identity).commands.length, 0,
    'cold history must exclude future blocks indexed in this tile');
  view.updateRasterState(state, 768, cache, identity, false);
  const rebuilt = view.completedTilePath(state, state.tileBlocks.get(1), 0, identity);
  assert.deepEqual(new Set(rebuilt.commands.map(([, x, z]) => `${x},${z}`)), new Set(['320,20']),
    'reconstruction must not restroke completed history belonging to other tiles');
  assert.equal(view.completedTilePath(state, state.tileBlocks.get(1), 2, identity).commands.length, 0,
    'an already committed block must not be stroked again during incremental updates');
});

test('scene invalidation covers colors, readiness, alignment, view, references, and mode', () => {
  const changes = [
    view => { view.playerColor = () => '#f00'; },
    view => { view.ready = true; },
    view => { view.transform.xz = .1; },
    view => { view.panX = 10; },
    view => { view.zoom = 2; },
    view => { view.canvas.clientWidth += 1; },
    view => { view.canvas.width *= 2; view.canvas.height *= 2; },
    view => { view.points = [{ u: 1, v: 2 }]; },
    view => { view.editing = {}; },
  ];
  for (const change of changes) {
    const view = makeView(), old = view.getRasterCache('persistent', 100, identity);
    change(view);
    assert.notEqual(view.getRasterCache('persistent', 101, identity), old);
    assert.equal(old.scene.width, 0);
  }
  const view = makeView(), persistent = view.getRasterCache('persistent', 100, identity);
  const full = view.getRasterCache('full', 100, identity);
  assert.notEqual(full, persistent);
  checkPath(statePath(full.states[0]), samples.length);
  full.dirty.clear();
  assert.equal(view.getRasterCache('full', 0, identity), full, 'full-route pixels survive timeline movement');
  assert.equal(full.dirty.size, 0);
  const rewind = view.getRasterCache('persistent', 100, identity);
  checkPath(statePath(rewind.states[0]), 101);
});

test('raster eviction releases storage, protects the active output, and bounds high-DPR scenes', () => {
  const view = makeView(), cache = view.getRasterCache('off', 0, null);
  const budget = 64 * 1024 * 1024, owner = new Map();
  const active = view.rasterResource(cache, 1024, 1024, 1, owner, 'active');
  const first = view.rasterResource(cache, 1024, 1024, 3, owner, 0, active);
  for (let i = 1; i < 20; i++) {
    view.rasterResource(cache, 1024, 1024, 3, owner, i, active);
    assert.ok(cache.bytes <= budget, 'scene, scratch, masks, and colored tiles share one budget');
  }
  assert.equal(owner.get('active'), active);
  assert.equal(first.canvases[0].width, 0);
  assert.equal(owner.has(0), false, 'an evicted tile cannot be mistaken for valid history');
  const rebuilt = view.rasterResource(cache, 1024, 1024, 3, owner, 0, active);
  assert.notEqual(rebuilt, first);
  assert.equal(rebuilt.canvases[0].width, 1024);
  view.clearRasterCache();
  assert.equal(active.canvases[0].width, 0);
  view.canvas.width = 6400; view.canvas.height = 4800;
  const large = view.getRasterCache('full', 0, identity);
  assert.equal(large.scene, null, 'oversized viewports must use evictable scene tiles');
  assert.ok(large.bytes <= budget);
});
