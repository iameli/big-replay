const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const atproto = runInNewContext(
  readFileSync(join(__dirname, '../atproto.js'), 'utf8') +
  '\n({ parseRoute, replayPath, buildReplayRecord, recordNicknames, withNickname, rkeyFromUri, REPLAY_COLLECTION })',
  { EventTarget, URLSearchParams });
const plain = value => JSON.parse(JSON.stringify(value));

test('routes: DIDs have a colon, handles have a dot, everything else stays free', () => {
  assert.deepEqual(plain(atproto.parseRoute('/')), { kind: 'home' });
  assert.deepEqual(plain(atproto.parseRoute('/did:plc:abc123/3lxyz')),
    { kind: 'replay', actor: 'did:plc:abc123', rkey: '3lxyz' });
  assert.deepEqual(plain(atproto.parseRoute('/iameli.com/3lxyz/')),
    { kind: 'replay', actor: 'iameli.com', rkey: '3lxyz' });
  assert.deepEqual(plain(atproto.parseRoute('/did%3Aweb%3Aexample.com')),
    { kind: 'actor', actor: 'did:web:example.com' });
  assert.deepEqual(plain(atproto.parseRoute('/iameli.com')), { kind: 'actor', actor: 'iameli.com' });
  for (const path of ['/settings', '/settings/x', '/iameli.com/a/b', '/did:plc:abc/..', '/%E0%A4%A', '/-bad.com'])
    assert.equal(atproto.parseRoute(path).kind, 'unknown', path);
});

test('replay paths round-trip through the router', () => {
  const path = atproto.replayPath('did:plc:abc123', '3lxyz');
  assert.equal(path, '/did:plc:abc123/3lxyz');
  assert.deepEqual(plain(atproto.parseRoute(path)), { kind: 'replay', actor: 'did:plc:abc123', rkey: '3lxyz' });
  assert.equal(atproto.rkeyFromUri(`at://did:plc:abc123/${atproto.REPLAY_COLLECTION}/3lxyz`), '3lxyz');
});

test('records hold integer durations, normalized datetimes, and players without empty fields', () => {
  const blob = { $type: 'blob', ref: { $link: 'bafk' }, mimeType: 'application/gzip', size: 3 };
  const record = plain(atproto.buildReplayRecord({
    blob, title: 'WR', description: '', durationMs: 4256803.69,
    header: { recordedAt: '2026-09-27T22:02:27.3621299Z', gameVersion: '1.5.1 2608271531' },
    players: [{ netId: 579, name: 'Rando' }, { netId: 0, name: '' }],
    stats: { maxPlayers: 12, gourdsPlaced: 45, towersCompleted: 9, deaths: 3 },
    createdAt: '2026-09-28T00:00:00.000Z',
  }));
  assert.deepEqual(record, {
    $type: 'com.iameli.bigWalk.replay', replay: blob, format: 'com.iameli.bigWalk.replay#jsonGzV1',
    createdAt: '2026-09-28T00:00:00.000Z', title: 'WR', recordedAt: '2026-09-27T22:02:27.362Z',
    durationMs: 4256804, gameVersion: '1.5.1 2608271531',
    players: [{ netId: 579, name: 'Rando' }, { netId: 0 }],
    stats: { maxPlayers: 12, gourdsPlaced: 45, towersCompleted: 9, deaths: 3 },
  });
});

test('nicknames are set and cleared per netId without touching recorded names', () => {
  const record = { players: [{ netId: 579, name: 'Rando' }] };
  const named = atproto.withNickname(record, 579, 'Randall');
  assert.deepEqual(plain(named.players), [{ netId: 579, name: 'Rando', nickname: 'Randall' }]);
  assert.deepEqual(plain(record.players), [{ netId: 579, name: 'Rando' }]);
  const added = atproto.withNickname(named, 580, 'Newbie', 'Timon');
  assert.deepEqual(plain([...atproto.recordNicknames(added)]), [[579, 'Randall'], [580, 'Newbie']]);
  const cleared = atproto.withNickname(added, 579, '');
  assert.deepEqual(plain(cleared.players[0]), { netId: 579, name: 'Rando' });
});
