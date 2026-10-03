const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const atproto = runInNewContext(
  readFileSync(join(__dirname, '../atproto.js'), 'utf8') +
  '\n({ parseRoute, parseHashRoute, replayPath, buildReplayRecord, streamplaceVideoUri, recordNicknames, recordPlayerCount, withNickname, rkeyFromUri, REPLAY_COLLECTION })',
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

test('hash routes support static index.html replay and account links', () => {
  const did = 'did:plc:2zmxikig2sj7gqaezl5gntae';
  assert.deepEqual(plain(atproto.parseHashRoute(`#${did}/3mwlzuf4ihz2e`)),
    { kind: 'replay', actor: did, rkey: '3mwlzuf4ihz2e' });
  assert.deepEqual(plain(atproto.parseHashRoute('#iameli.com')), { kind: 'actor', actor: 'iameli.com' });
  assert.deepEqual(plain(atproto.parseHashRoute(
    `#at://${did}/com.iameli.bigWalk.replay/3mwlzuf4ihz2e`)),
    { kind: 'replay', actor: did, rkey: '3mwlzuf4ihz2e' });
  for (const hash of ['', '#', '#settings', '#at://bsky.app/app.bsky.feed.post/3mw'])
    assert.equal(atproto.parseHashRoute(hash), null, hash);
});

test('records hold integer durations, normalized datetimes, and players without empty fields', () => {
  const blob = { $type: 'blob', ref: { $link: 'bafk' }, mimeType: 'application/gzip', size: 3 };
  const record = plain(atproto.buildReplayRecord({
    blob, title: 'WR', description: '', durationMs: 4256803.69,
    video: ' at://did:plc:video123/place.stream.video/3mxyz ',
    videoStartMs: 532547.6,
    header: { recordedAt: '2026-09-27T22:02:27.3621299Z', gameVersion: '1.5.1 2608271531' },
    players: [{ netId: 579, name: 'Rando' }, { netId: 0, name: '' }],
    stats: { maxPlayers: 12, gourdsPlaced: 45, towersCompleted: 9, deaths: 3 },
    createdAt: '2026-09-28T00:00:00.000Z',
  }));
  assert.deepEqual(record, {
    $type: 'com.iameli.bigWalk.replay', replay: blob, format: 'com.iameli.bigWalk.replay#jsonGzV1',
    createdAt: '2026-09-28T00:00:00.000Z', title: 'WR', recordedAt: '2026-09-27T22:02:27.362Z',
    video: 'at://did:plc:video123/place.stream.video/3mxyz',
    videoStartMs: 532548,
    durationMs: 4256804, gameVersion: '1.5.1 2608271531',
    players: [{ netId: 579, name: 'Rando' }, { netId: 0 }],
    stats: { maxPlayers: 12, gourdsPlaced: 45, towersCompleted: 9, deaths: 3 },
  });
});

test('Streamplace video references reject other collections and malformed AT URIs', () => {
  assert.equal(atproto.streamplaceVideoUri('at://did:plc:abc/place.stream.video/3mxyz'),
    'at://did:plc:abc/place.stream.video/3mxyz');
  for (const value of [
    'https://stream.place/video/3mxyz',
    'at://did:plc:abc/app.bsky.feed.post/3mxyz',
    'at://alice.example/place.stream.video/3mxyz',
    'at://did:plc:abc/place.stream.video/../extra',
  ]) assert.equal(atproto.streamplaceVideoUri(value), null, value);
  assert.throws(() => atproto.buildReplayRecord({
    blob: { $type: 'blob' },
    video: 'at://did:plc:abc/app.bsky.feed.post/3mxyz',
    players: [],
    createdAt: '2026-09-28T00:00:00.000Z',
  }), /place\.stream\.video/);
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

test('Tynan-linking: an AT-URI path redirects to the canonical replay or account path', () => {
  const did = 'did:plc:2zmxikig2sj7gqaezl5gntae', uri = `at://${did}/com.iameli.bigWalk.replay/3mwluftfxqb2e`;
  const expected = { kind: 'replay', actor: did, rkey: '3mwluftfxqb2e', redirect: `/${did}/3mwluftfxqb2e` };
  assert.deepEqual(plain(atproto.parseRoute(`/${uri}`)), expected);
  assert.deepEqual(plain(atproto.parseRoute(`/${encodeURIComponent(uri)}`)), expected);
  assert.deepEqual(plain(atproto.parseRoute(`/at:/${did}/com.iameli.bigWalk.replay/3mwluftfxqb2e/`)), expected);
  assert.deepEqual(plain(atproto.parseRoute('/at://iame.li/com.iameli.bigWalk.replay/3mw')),
    { kind: 'replay', actor: 'iame.li', rkey: '3mw', redirect: '/iame.li/3mw' });
  assert.deepEqual(plain(atproto.parseRoute(`/at://${did}`)), { kind: 'actor', actor: did, redirect: `/${did}` });
  assert.deepEqual(plain(atproto.parseRoute(`/at://${did}/com.iameli.bigWalk.replay`)),
    { kind: 'actor', actor: did, redirect: `/${did}` });
  for (const path of [`/at://${did}/app.bsky.feed.post/3mw`, '/at://nope/com.iameli.bigWalk.replay/3mw',
    `/at://${did}/com.iameli.bigWalk.replay/3mw/extra`])
    assert.deepEqual(plain(atproto.parseRoute(path)), { kind: 'unknown' }, path);
});

test('record player counts skip netId 0 and count a reconnected name once', () => {
  assert.equal(atproto.recordPlayerCount({ players: [{ netId: 0 }, { netId: 590, name: 'xCape' },
    { netId: 592, name: 'xCape' }, { netId: 579, name: 'Rando' }, { netId: 600 }] }), 3);
});
