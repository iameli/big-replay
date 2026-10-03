const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { normalizeReplayPlayers, canonicalPlayerNumber, canonicalPlayerOrder } = runInNewContext(
  readFileSync(join(__dirname, '../replay-players.js'), 'utf8')
    + '\n({ normalizeReplayPlayers, canonicalPlayerNumber, canonicalPlayerOrder })');
const plain = value => JSON.parse(JSON.stringify(value));
const player = (netId, name, extra = {}) => ({ netId, name, x: 0, z: 0, ...extra });
const ids = frame => frame.players.map(p => p.netId);

test('P-prefixed player names use numeric canonical order', () => {
  const labels = new Map([
    [579, 'P12 - Rando'],
    [580, 'P6 - Majus'],
    [581, 'P9 - xCape'],
    [582, 'P11 - Fookeach'],
  ]);
  assert.equal(canonicalPlayerNumber('P9 - xCape'), 9);
  assert.equal(canonicalPlayerNumber('player 9'), null);
  assert.deepEqual(
    plain(canonicalPlayerOrder(labels.keys(), id => labels.get(id))),
    [580, 581, 582, 579],
  );
});

test('canonical player order keeps unnumbered and duplicate slots deterministic', () => {
  const labels = new Map([[8, 'Rando'], [6, 'P2 - B'], [4, 'P2 - A'], [2, 'Majus']]);
  assert.deepEqual(
    plain(canonicalPlayerOrder(labels.keys(), id => labels.get(id))),
    [4, 6, 2, 8],
  );
});

test('netId 0 spawning placeholders and their join/leave events are dropped', () => {
  const replay = {
    frames: [{ players: [player(579, 'Rando'), player(0, null, { isPending: true })], gourds: [] },
      { players: [player(579, 'Rando')], gourds: [] }],
    events: [{ type: 'player-joined', detail: '579' }, { type: 'player-joined', detail: '0' },
      { type: 'player-left', detail: '0' }, { type: 'death', detail: '0' }],
  };
  assert.equal(normalizeReplayPlayers(replay).size, 0);
  assert.deepEqual(replay.frames.map(ids), [[579], [579]]);
  assert.deepEqual(plain(replay.events), [{ type: 'player-joined', detail: '579' }, { type: 'death', detail: '0' }]);
});

test('a reconnect with the same name and no overlap merges into the first netId', () => {
  const replay = {
    frames: [
      { players: [player(579, 'Rando'), player(590, 'xCape')], gourds: [] },
      { players: [player(579, 'Rando')], gourds: [] },
      // Names are unreadable during the first pending frames after rejoining.
      { players: [player(579, 'Rando'), player(592, null, { isPending: true })], gourds: [] },
      { players: [player(579, 'Rando'), player(592, 'xCape')], gourds: [{ name: 100, holderNetId: 592 }] },
    ],
    events: [{ type: 'player-left', detail: '590' }, { type: 'player-joined', detail: '592' }],
  };
  assert.deepEqual(plain([...normalizeReplayPlayers(replay)]), [[590, [590, 592]]]);
  assert.deepEqual(replay.frames.map(ids), [[579, 590], [579], [579, 590], [579, 590]]);
  assert.equal(replay.frames[3].gourds[0].holderNetId, 590);
  assert.deepEqual(plain(replay.events), [{ type: 'player-left', detail: '590' }, { type: 'player-joined', detail: '590' }]);
});

test('same-named players who overlap, or ambiguous rejoins, stay separate', () => {
  const overlap = { frames: [{ players: [player(1, 'Sam'), player(2, 'Sam')], gourds: [] }], events: [] };
  assert.equal(normalizeReplayPlayers(overlap).size, 0);
  assert.deepEqual(overlap.frames.map(ids), [[1, 2]]);
  const ambiguous = {
    frames: [{ players: [player(1, 'Sam'), player(2, 'Sam')], gourds: [] }, { players: [player(3, 'Sam')], gourds: [] }],
    events: [],
  };
  assert.equal(normalizeReplayPlayers(ambiguous).size, 0);
  assert.deepEqual(ambiguous.frames.map(ids), [[1, 2], [3]]);
});

test('several reconnects chain onto one player', () => {
  const replay = {
    frames: [{ players: [player(5, 'Ana')] }, { players: [] }, { players: [player(7, 'Ana')] },
      { players: [] }, { players: [player(9, 'Ana')] }],
    events: [],
  };
  assert.deepEqual(plain([...normalizeReplayPlayers(replay)]), [[5, [5, 7, 9]]]);
  assert.deepEqual(replay.frames.map(ids), [[5], [], [5], [], [5]]);
});
