const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const {
  PlaybackLayoutState, normalizePlaybackSelection, playbackGridColumns, playbackGridShape,
} = runInNewContext(
  readFileSync(join(__dirname, '../playback-layout.js'), 'utf8')
    + '\n({ PlaybackLayoutState, normalizePlaybackSelection, playbackGridColumns, playbackGridShape })',
);

test('playback selections keep one available view and canonical player order', () => {
  const state = new PlaybackLayoutState([], 3);
  assert.equal(state.toggle('map'), false);
  assert.deepEqual([...state.selection], ['map']);

  assert.equal(state.toggle('p3'), true);
  assert.equal(state.toggle('p1'), true);
  assert.deepEqual([...state.selection], ['map', 'p1', 'p3']);
  assert.equal(state.toggle('p4'), false);

  state.toggle('map');
  state.toggle('p1');
  assert.deepEqual([...state.selection], ['p3']);
  assert.equal(state.toggle('p3'), false);
  assert.deepEqual([...normalizePlaybackSelection(['p2', 'p2', 'p9'], 3)], ['p2']);
});

test('named layouts replace by name, recall against available players, and delete', () => {
  const state = new PlaybackLayoutState([], 12);
  state.setSelection(['map', 'p2', 'p8']);
  state.save('Commentary');
  state.setSelection(['p1']);
  state.save('Commentary');
  state.setSelection(['p3', 'p4']);
  state.save('Runners');

  assert.deepEqual([...state.savedLayouts].map(layout => layout.name), ['Commentary', 'Runners']);
  state.setPlayerCount(2);
  assert.equal(state.recall('Runners'), true);
  assert.deepEqual([...state.selection], ['map']);
  assert.equal(state.recall('Commentary'), true);
  assert.deepEqual([...state.selection], ['p1']);
  assert.equal(state.remove('Commentary'), true);
  assert.deepEqual([...state.savedLayouts].map(layout => layout.name), ['Runners']);
});

test('responsive grid maximizes sixteen-by-nine view size', () => {
  assert.equal(playbackGridColumns(1, 1600, 900), 1);
  assert.equal(playbackGridColumns(4, 1600, 900), 2);
  assert.equal(playbackGridColumns(12, 1600, 900), 4);
  assert.equal(playbackGridColumns(12, 900, 1600), 2);
  assert.deepEqual(
    { ...playbackGridShape(3, 1400, 1070) },
    { columns: 2, rows: 2, leadRows: 2, trailingColumns: 1 },
  );
});

test('mosaic default exposes every camera and saved layouts retain independent sizing', () => {
  const state = new PlaybackLayoutState([], 12);
  state.showMosaicDefault();
  assert.deepEqual([...state.selection], ['map', ...Array.from({ length: 12 }, (_, i) => `p${i + 1}`)]);
  state.sizing.mapFraction = 0.25;
  state.sizing.tracks.c2 = [0.3, 0.7];
  state.save('Big cameras');
  state.sizing.tracks.c2[0] = 0.9;
  state.showMosaicDefault();
  state.recall('Big cameras');
  assert.equal(state.sizing.mapFraction, 0.25);
  assert.deepEqual([...state.sizing.tracks.c2], [0.3, 0.7]);

  const reloaded = new PlaybackLayoutState(JSON.parse(JSON.stringify(state.savedLayouts)), 12);
  reloaded.recall('Big cameras');
  assert.equal(reloaded.sizing.mapFraction, 0.25);
  assert.deepEqual([...reloaded.sizing.tracks.c2], [0.3, 0.7]);

  const legacy = new PlaybackLayoutState([{ name: 'Old layout', selection: ['map', 'p1'] }], 12);
  legacy.recall('Old layout');
  assert.deepEqual([...legacy.selection], ['map', 'p1']);
  assert.ok(legacy.sizing.mapFraction > 0.5 && legacy.sizing.mapFraction < 1);
});
