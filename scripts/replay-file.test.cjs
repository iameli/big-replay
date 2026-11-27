const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { gzipSync, gunzipSync } = require('node:zlib');
const { decodeReplayFile, replayUploadBytes, normalizeReplayPlayers } = runInNewContext(
  ['replay-file.js', 'replay-players.js'].map(f => readFileSync(join(__dirname, '..', f), 'utf8')).join('\n') +
  '\n({ decodeReplayFile, replayUploadBytes, normalizeReplayPlayers })',
  { Blob, Response, DecompressionStream, CompressionStream, TextDecoder });

const header = { header: { formatVersion: 2, gameVersion: '1.5', unityVersion: '6000',
  recordedAt: '2026-01-02T03:04:05Z', sampleIntervalSec: 0.1, landmarks: [] } };
const lines = (...records) => Buffer.from(records.map(x => JSON.stringify(x) + '\n').join(''));
const file = (...records) => lines(header, ...records);
const bytes = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const decode = (buf, expectedVersion) => decodeReplayFile(bytes(buf), expectedVersion);
const plain = value => JSON.parse(JSON.stringify(value));

test('every sample is reconstructed; unchanged arrays and slots are shared without mutating history', async () => {
  const a = { netId: 3, name: 'old' }, b = { netId: 3, name: 'new' };
  const e1 = { time: 0, type: 'run-started' }, e2 = { time: 0.2, type: 'death', detail: '3' };
  const { replay } = await decode(file(
    { event: e1 }, { frame: { time: 0 } },
    { frame: { time: 0.1, players: [2, 0, a, 1, b], gourds: [1, 0, { name: 77, state: 0 }],
      monuments: [1, 0, { homeName: 5, filled: true }] } }, { event: e2 },
    { frame: { time: 0.2 } }, { frame: { time: 0.3, players: [2, 0, { netId: 9 }], monuments: [0] } },
    { frame: { time: 0.4, players: [1, 0, b], gourds: [2, 0, { name: 77 }, 1, { name: 77 }] } }));
  const [empty, initial, unchanged, edited, shorter] = replay.frames;
  assert.deepEqual(plain(replay.frames.map(f => f.time)), [0, 0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual(plain(replay.header), header.header);
  assert.deepEqual(plain(replay.events), [e1, e2]);
  assert.deepEqual(plain(empty), { time: 0, players: [], gourds: [], monuments: [] });
  for (const key of ['players', 'gourds', 'monuments']) assert.equal(initial[key], unchanged[key]);
  assert.notEqual(edited.players, initial.players);
  assert.equal(edited.players[1], initial.players[1]);
  assert.deepEqual(plain(initial.players), [a, b]);
  assert.deepEqual(plain(edited.players), [{ netId: 9 }, b]);
  assert.deepEqual(plain(shorter.players), [b]);
  assert.deepEqual(plain(shorter.gourds), [{ name: 77 }, { name: 77 }]);
  assert.equal(shorter.monuments, edited.monuments);
  assert.deepEqual(plain(edited.monuments), []);
  assert.deepEqual(plain(initial.monuments), [{ homeName: 5, filled: true }]);
});

test('normalization preserves shared arrays and never rewrites an earlier snapshot', async () => {
  const pending = { netId: 0 }, old = { netId: 10, name: 'Sam' }, reconnect = { netId: 20, name: 'Sam' };
  const { replay } = await decode(file(
    { frame: { time: 0, players: [2, 0, old, 1, pending] } },
    { frame: { time: 1, players: [2, 0, reconnect], gourds: [1, 0, { name: 7, holderNetId: 20 }] } },
    { frame: { time: 2 } }, { frame: { time: 3, players: [2, 1, { netId: 30 }] } }));
  const [a, b, c, d] = replay.frames;
  const recorded = b.players, carried = b.gourds;
  normalizeReplayPlayers(replay);
  assert.deepEqual(plain(recorded), [reconnect, pending]);
  assert.equal(carried[0].holderNetId, 20);
  assert.deepEqual(plain(a.players), [old]);
  assert.deepEqual(plain(b.players), [old]);
  assert.equal(c.players, b.players);
  assert.equal(d.players[0], b.players[0]);
  assert.deepEqual(plain(d.players), [old, { netId: 30 }]);
  assert.equal(d.gourds, b.gourds);
  assert.equal(b.gourds[0].holderNetId, 10);
});

test('only newline-terminated UTF-8 records commit, including when sharing the recovered prefix', async () => {
  const complete = file({ frame: { time: 1, players: [1, 0, { netId: 1, name: '雪' }] } });
  for (const tail of [Buffer.from('{"frame":{"time":2}}'), Buffer.from([0x7b, 0xc3]), Buffer.from(' ')]) {
    const torn = Buffer.concat([complete, tail]);
    for (const input of [torn, gzipSync(torn)]) {
      const { replay, source } = await decode(input);
      assert.equal(replay.frames.length, 1);
      assert.equal(replay.frames[0].players[0].name, '雪');
      assert.equal(source.recovered, true);
      assert.deepEqual(gunzipSync(Buffer.from(await replayUploadBytes(source))), complete);
    }
  }
  await assert.rejects(decode(Buffer.concat([complete, Buffer.from([0x7b, 0xc3, 10])])), /line 3/);
  await assert.rejects(decode(file().subarray(0, -1)), /header/);
});

test('malformed completed records are errors, even if a later tail is incomplete', async () => {
  const prefix = file({ frame: { time: 0, gourds: [1, 0, { name: 5 }] } });
  const badPatches = [null, {}, [], [-1], [1.5], [0xffffffff], [2], [1, 1, { name: 5 }],
    [2, 0, { name: 5 }], [3, 2, { name: 5 }], [2, 1, { name: 5 }, 0, { name: 5 }],
    [1, 0, { name: 5 }, 0, { name: 6 }], [1, -1, {}], [1, 0], [1, 0, {}], [1, 0, null], [1, 0, []]];
  const badRecords = badPatches.map(gourds => ({ frame: { time: 1, gourds } })).concat([
    header, { frame: {} }, { frame: { time: 1 }, event: {} }, { frame: { time: 1, typo: [] } },
    { event: { time: 1 } }, { event: { time: 1, type: 'ok', detail: {} } }, null, {}, []]);
  for (const bad of [Buffer.from('{bad}\n'), Buffer.from('\n'), ...badRecords.map(x => lines(x))]) {
    await assert.rejects(decode(Buffer.concat([prefix, bad, Buffer.from('{')])), /line 3/);
  }
});

test('legacy compact and pretty v1 documents are not mistaken for JSON Lines', async () => {
  const v1 = { header: { formatVersion: 1 }, frames: [{ time: 0, players: [], gourds: [], monuments: [] }], events: [] };
  for (const content of [JSON.stringify(v1), JSON.stringify(v1) + '\n', JSON.stringify(v1, null, 2)]) {
    const raw = Buffer.from(content);
    for (const input of [raw, gzipSync(raw)]) {
      const { replay, source } = await decode(input);
      assert.deepEqual(plain(replay), v1);
      const uploaded = await replayUploadBytes(source);
      assert.deepEqual(gunzipSync(Buffer.from(uploaded)), raw);
      if (source.gzipped) assert.equal(uploaded, source.buf);
      await decodeReplayFile(uploaded, 1);
      await assert.rejects(decodeReplayFile(uploaded, 2), /format/);
    }
  }
});

test('v2 uploads and downloads use gzip and check the declared wire version', async () => {
  const raw = file({ frame: { time: 1 } });
  const compressed = gzipSync(raw);
  await assert.rejects(decode(raw, 2), /gzip/);
  await assert.rejects(decode(compressed, 1), /format/);
  await assert.rejects(decode(compressed.subarray(0, -5)));
  for (const input of [raw, compressed]) {
    const { source } = await decode(input);
    const upload = await replayUploadBytes(source);
    if (source.gzipped) assert.equal(upload, source.buf);
    const { replay } = await decodeReplayFile(upload, 2);
    assert.deepEqual(plain(replay.frames), [{ time: 1, players: [], gourds: [], monuments: [] }]);
  }
});
