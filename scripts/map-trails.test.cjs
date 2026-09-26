const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

// Record the geometry submitted to Canvas; these checks need no browser or packages.
class RecordedPath {
  constructor(copy) { this.commands = copy?.commands.slice() || []; }
  moveTo(x, z) { this.commands.push(['M', x, z]); }
  lineTo(x, z) { this.commands.push(['L', x, z]); }
  addPath(path) { this.commands.push(...path.commands); }
}
const MapView = runInNewContext(
  readFileSync(join(__dirname, '../map-view.js'), 'utf8') + '\nMapView',
  { Path2D: RecordedPath });
const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const samples = Array.from({ length: 800 }, (_, i) => [
  i + (i >= 130 ? 6 : 0) + (i >= 520 ? 4 : 0),
  i, Math.sin(i / 31) * .1 + (i % 100 === 50 ? 3 : 0),
]);
function makeView() {
  const view = Object.create(MapView.prototype);
  view.routes = [{ netId: 1, samples, tolerance: null }];
  view.routeMatrix = () => identity;
  view.playerColor = () => '#fff';
  return view;
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

test('persistent trails respect frame cutoffs, gaps, and backward seeks across block boundaries', () => {
  const view = makeView();
  let path;
  view.strokeRoute = (_, rendered) => { path = rendered; };
  // Both sides of each gap/block boundary, including rewinds within the same block.
  for (const frame of [-1, 0, 129, 130, 135, 136, 260, 261, 262, 517, 518,
    529, 809, 539, 530, 525, 262, 261, 260, 8, 808]) {
    view.drawTrails(null, frame, 'persistent');
    const next = samples.findIndex(p => p[0] > frame);
    checkPath(path, next < 0 ? samples.length : next);
  }
});

test('zoom, reflection, and sheared alignment retain the screen-space error bound', () => {
  const view = makeView(), route = view.routes[0];
  for (const [a, b, c, d] of [[.66, 0, 0, .66], [16, 0, 0, 16],
    [1.7, .3, 2.2, .8], [-1.5, .7, -.4, 1.2], [.01, 0, 0, .02]]) {
    const matrix = { a, b, c, d, e: 10, f: -4 };
    const tolerance = view.routeTolerance(matrix);
    for (const end of [800, 519, 256, 255, 1, 799]) {
      checkPath(view.persistentPath(route, end, tolerance), end, matrix);
    }
  }
});

test('recent trails exclude older history after switching from persistent mode', () => {
  const view = makeView();
  let path;
  view.strokeRoute = (_, rendered) => { path = rendered; };
  view.drawTrails(null, 809, 'persistent');
  view.drawTrails(null, 140, 'recent');
  checkPath(path, samples.findIndex(p => p[0] > 140));
  for (const [, x] of path.commands) assert.ok(samples[x][0] >= 100,
    'recent trails may contain only the last 40 frame intervals');
});

test('loading another replay discards old routes and breaks lines at invalid positions', () => {
  const view = makeView();
  view.updateUI = () => {};
  view.persistentPath(view.routes[0], 800, .25);
  view.setReplay([
    { players: [{ netId: 7, x: 10, z: 20 }] },
    { players: [{ netId: 7, x: NaN, z: 20 }] },
    { players: [] },
    { players: [{ netId: 7, x: 30, z: 40 }] },
    { players: [{ netId: 7, x: 30, z: 40 }] },
  ]);
  assert.equal(view.routes.length, 1);
  assert.equal(view.routes[0].netId, 7);
  const path = view.persistentPath(view.routes[0], 3, .25);
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
