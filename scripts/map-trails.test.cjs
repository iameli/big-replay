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
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.context = new RecordedContext();
  }
  getContext() { return this.context; }
}
class RecordedContext {
  constructor() { this.strokes = []; this.images = []; }
  getTransform() { return identity; }
  setTransform() {}
  save() {}
  restore() {}
  beginPath() {}
  rect() {}
  clip() {}
  clearRect() {}
  fillRect() {}
  arc() {}
  fillText() {}
  stroke(path) {
    if (path) this.strokes.push(path.commands.map(command => [...command]));
  }
  drawImage(image, ...args) { this.images.push({ image, args }); }
}
class Matrix {
  constructor([a, b, c, d, e, f]) { Object.assign(this, { a, b, c, d, e, f }); }
}
const MapView = runInNewContext(
  readFileSync(join(__dirname, '../map-view.js'), 'utf8') + '\nMapView',
  { Path2D: RecordedPath, OffscreenCanvas: Bitmap, DOMMatrix: Matrix });
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
function drawingView(positions = samples) {
  const view = makeView(positions);
  view.canvas.width = view.canvas.clientWidth = 512;
  view.canvas.height = view.canvas.clientHeight = 256;
  view.viewport = () => ({ scale: view.zoom, ox: view.panX, oy: view.panY });
  const context = new RecordedContext();
  return { view, context, draw: (frame, mode = 'persistent') => {
    view.draw(context, frame, mode);
    return view.rasterCache;
  } };
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
  const { view, draw } = drawingView([[0, 0, 10], [1, 200, 10.2], [2, 400, 10.4], [3, 600, 10]]);
  const cache = draw(2), state = cache.states[0];
  const oldPath = state.live;
  assert.ok(!oldPath.commands.some(([, x]) => x === 200), 'first prefix simplifies to one segment');
  cache.dirty.clear();
  view.getRasterCache('persistent', 3, identity);
  assert.notEqual(state.live, oldPath);
  assert.ok(state.live.commands.some(([, x]) => x === 400), 'the new endpoint revises earlier geometry');
  for (const id of ['0,0', '1,0', '2,0']) {
    assert.ok(cache.dirty.has(id), 'both old and new live geometry coverage must be invalidated');
  }
  assert.equal(state.complete, 0, 'a mutable prefix must never enter immutable history');
});

test('ordinary playback dirties only affected tiles and stationary extensions keep pixels', () => {
  const positions = Array.from({ length: 300 }, (_, i) => [i, i < 256 ? 20 : 600, 20]);
  positions[257] = [257, 610, 20];
  for (let i = 258; i < positions.length; i++) positions[i] = [i, 610, 20];
  const { view, draw } = drawingView(positions), cache = draw(256);
  cache.dirty.clear();
  view.getRasterCache('persistent', 257, identity);
  assert.deepEqual([...cache.dirty].sort(), ['0,0', '1,0', '2,0'],
    'the live boundary segment spans three tiles without dirtying unaffected rows');
  cache.dirty.clear();
  const live = cache.states[0].live;
  view.getRasterCache('persistent', 298, identity);
  assert.equal(cache.dirty.size, 0);
  assert.equal(cache.states[0].live, live);
  assert.equal(cache.states[0].end, 299, 'stationary playback still advances the cutoff');
});

test('lazy spatial indexing retains crossing segments, boundary halos, and affine placement', () => {
  const view = makeView(), cache = view.getRasterCache('off', 0, null);
  const tile = (x, y = 0) => ({ id: `${x},${y}`, x: x * 256, y: y * 256, width: 256, height: 256 });
  const indexed = (positions, matrix = identity) => view.rasterState(
    { netId: 2, tolerance: null, samples: positions }, cache, matrix);
  const boundary = indexed([[0, 255, 20], [1, 255, 30]]);
  for (const x of [0, 1]) assert.deepEqual(Array.from(view.blocksForTile(boundary, tile(x))), [0],
    'the outline halo must cover both sides of a tile boundary');
  const crossing = indexed([[0, -100, 20], [1, 1100, 30]]);
  for (const x of [-1, 0, 1, 2, 3, 4]) {
    assert.deepEqual(Array.from(view.blocksForTile(crossing, tile(x))), [0],
      'segments crossing a tile must be indexed even when neither endpoint is inside it');
  }
  assert.deepEqual(Array.from(view.blocksForTile(crossing, tile(0, -1))), []);
  const reflected = indexed([[0, 10, 10], [1, 30, 30]],
    { a: -1, b: 0, c: 0, d: 1, e: 768, f: 0 });
  assert.deepEqual(Array.from(view.blocksForTile(reflected, tile(2))), [0]);
  assert.deepEqual(Array.from(view.blocksForTile(reflected, tile(0))), []);
  const state = indexed(Array.from({ length: 768 }, (_, i) =>
    [i + Math.floor(i / 256), Math.floor(i / 256) * 300 + 20, 20]));
  assert.equal(state.tileBlocks.size, 0, 'indexing must be lazy rather than enumerate the map grid');
  const blocks = view.blocksForTile(state, tile(1));
  assert.deepEqual(Array.from(blocks), [1]);
  view.updateRasterState(state, 256, cache, identity, false);
  assert.equal(view.completedTilePath(state, blocks, 0, identity).commands.length, 0,
    'cold history must exclude future blocks indexed in this tile');
  view.updateRasterState(state, 768, cache, identity, false);
  const rebuilt = view.completedTilePath(state, blocks, 0, identity);
  assert.deepEqual(new Set(rebuilt.commands.map(([, x, z]) => `${x},${z}`)), new Set(['320,20']),
    'reconstruction must not restroke completed history belonging to other tiles');
  assert.equal(view.completedTilePath(state, blocks, 2, identity).commands.length, 0,
    'an already committed block must not be stroked again during incremental updates');
});

test('large zoomed bounds index only resident tiles rather than the global map grid', () => {
  const { view, draw } = drawingView([[0, -1e8, -1e8], [1, 1e8, 1e8]]);
  view.zoom = 16;
  const cache = draw(1, 'full'), state = cache.states[0];
  assert.ok(state.tileBlocks.size <= cache.outputs.size + state.masks.size,
    'huge block bounds must not allocate metadata for every intersected world tile');
  assert.ok(cache.bytes <= 64 * 1024 * 1024);
  view.panX = -1e6;
  assert.equal(draw(1, 'full'), cache);
  assert.ok(state.tileBlocks.size <= cache.outputs.size + state.masks.size);
});

test('scene invalidation covers colors, readiness, alignment, scale, references, and mode', () => {
  const changes = [
    view => { view.playerColor = () => '#f00'; },
    view => { view.ready = true; },
    view => { view.transform.xz = .1; },
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

test('fractional pans and signed grid crossings preserve reusable tile rasters', () => {
  const positions = Array.from({ length: 601 }, (_, i) => [i, i * 5 - 1500, 80]);
  const { view, draw } = drawingView(positions), cache = draw(600, 'full');
  const originals = new Map([...cache.outputs].map(([id, resource]) =>
    [id, { resource, paints: resource.canvases[0].context.images.length }]));
  assert.ok(originals.has('0,0'), 'the starting map tile must have a raster');
  for (const pan of [.5, 80.25, 300.75, -300.25, -700.5, 0]) {
    view.panX = pan;
    assert.equal(draw(600, 'full'), cache, 'translation must not replace the raster cache');
    for (const [id, { resource, paints }] of originals) {
      assert.equal(cache.outputs.get(id), resource, 'reusable output must survive panning');
      assert.equal(resource.canvases[0].context.images.length, paints,
        'unchanged trail tiles must not be recomposited when panning');
    }
  }
  for (const id of ['-2,0', '3,0', '4,0']) {
    const output = cache.outputs.get(id);
    assert.ok(output, `newly exposed map tile ${id} must be rendered immediately`);
    assert.ok(output.canvases[0].context.images.some(({ image }) => image === cache.scratch ||
      [...cache.states[0].masks.values()].some(mask => mask.canvases.includes(image))),
    'a newly exposed trail tile must compose its geometry, not a blank cached snapshot');
  }
});

test('offscreen playback refreshes returning tiles and rewind releases future rasters', () => {
  const { view, draw } = drawingView(), cache = draw(100);
  const old = cache.outputs.get('0,0'), paints = old.canvases[0].context.images.length;
  view.panX = -2048;
  assert.equal(draw(100), cache);
  assert.equal(draw(600), cache);
  assert.equal(cache.outputs.get('0,0'), old, 'offscreen tiles remain reusable within the budget');
  assert.equal(old.canvases[0].context.images.length, paints,
    'offscreen playback must not eagerly repaint unseen tiles');
  view.panX = 0;
  assert.equal(draw(600), cache);
  assert.ok(old.canvases[0].context.images.length > paints,
    'returning tiles must incorporate playback that occurred offscreen');
  const next = samples.findIndex(sample => sample[0] > 600);
  checkPath(statePath(cache.states[0]), next);
  const masks = cache.states[0].masks.get('0,0');
  assert.ok(masks.canvases[0].context.strokes.flat().some(([, x]) => x === 255),
    'returning tiles must reconstruct newly completed history');
  view.panX = 300.5;
  const rewind = draw(8);
  assert.notEqual(rewind, cache, 'rewind must invalidate even after panning');
  assert.equal(old.canvases[0].width, 0, 'future tile pixels must be released on rewind');
  checkPath(statePath(rewind.states[0]), 9);
  view.panX = 0;
  assert.equal(draw(8), rewind);
  assert.notEqual(rewind.outputs.get('0,0'), old);
  checkPath(statePath(rewind.states[0]), 9);
});

test('panning beyond the raster budget evicts and reconstructs completed tile history', () => {
  const positions = Array.from({ length: 601 }, (_, i) => [i, i * 300, 80]);
  const { view, draw } = drawingView(positions), cache = draw(600, 'full');
  const first = cache.outputs.get('0,0');
  const strokes = cache.states[0].masks.get('0,0').canvases[0].context.strokes;
  const expected = strokes.flat().map(command => [...command]);
  for (let i = 1; i <= 180; i++) {
    view.panX = -i * 1024;
    assert.equal(draw(600, 'full'), cache);
    assert.ok(cache.bytes <= 64 * 1024 * 1024,
      'retained tiles, masks, scene, and scratch must share the 64 MiB cap');
    const state = cache.states[0];
    assert.ok(state.tileBlocks.size <= cache.outputs.size + state.masks.size,
      'eviction must release the corresponding unowned spatial index entries');
  }
  assert.equal(first.canvases[0].width, 0, 'cold output storage must eventually be released');
  assert.equal(cache.outputs.has('0,0'), false, 'evicted pixels cannot remain marked as reusable');
  // Masks may be evicted again as later tiles are composed. Observe the rebuilt
  // history at allocation rather than require it to remain resident after draw.
  let reconstructed;
  const allocate = view.rasterResource;
  view.rasterResource = function(...args) {
    const resource = allocate.apply(this, args);
    if (args[4] === cache.states[0].masks && args[5] === '0,0') reconstructed = resource;
    return resource;
  };
  view.panX = 0;
  assert.equal(draw(600, 'full'), cache);
  const rebuilt = cache.outputs.get('0,0');
  assert.notEqual(rebuilt, first);
  assert.deepEqual(reconstructed.canvases[0].context.strokes.flat(), expected,
    'returning to evicted tiles must reconstruct the same completed history');
  assert.ok(cache.bytes <= 64 * 1024 * 1024);
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
