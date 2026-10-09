const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const {
  LIVE_DEFAULT_ADDRESS, LIVE_PROTOCOL_VERSION, LiveLineReader, LiveReplayBuffer, LiveReplayClient,
  liveBlockedReason, liveReconnectDelay, liveStartTime, parseLiveAddress,
} = runInNewContext(
  readFileSync(join(__dirname, '../live-client.js'), 'utf8')
    + '\n({ LIVE_DEFAULT_ADDRESS, LIVE_PROTOCOL_VERSION, LiveLineReader, LiveReplayBuffer,'
    + ' LiveReplayClient, liveBlockedReason, liveReconnectDelay, liveStartTime, parseLiveAddress })',
  { TextDecoder, Blob, URL, setTimeout, clearTimeout },
);

/** Records what the client does to a socket, so reconnection can be inspected without timers. */
class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.closed = false;
    FakeSocket.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emitOpen() { this.onopen?.({}); }

  emitMessage(data) { this.onmessage?.({ data }); }

  emitClose(code = 1006, reason = "") { this.onclose?.({ code, reason }); }
}

const line = message => `${JSON.stringify(message)}\n`;
const openedClient = (options = {}) => {
  FakeSocket.instances.length = 0;
  const messages = [], statuses = [];
  const client = new LiveReplayClient({
    url: options.url ?? LIVE_DEFAULT_ADDRESS,
    WebSocketImpl: FakeSocket,
    onMessage: message => messages.push(message),
    onStatus: status => statuses.push(status),
    ...options,
  });
  client.connect();
  const socket = FakeSocket.instances.at(-1);
  socket.emitOpen();
  return { client, socket, messages, statuses };
};

test('live addresses accept ws, http, bare host, and reject nonsense', () => {
  assert.equal(parseLiveAddress("ws://127.0.0.1:8787"), "ws://127.0.0.1:8787/");
  assert.equal(parseLiveAddress("127.0.0.1:8787"), "ws://127.0.0.1:8787/");
  assert.equal(parseLiveAddress("  http://192.168.1.5:8787/  "), "ws://192.168.1.5:8787/");
  assert.equal(parseLiveAddress("https://box.example/live"), "wss://box.example/live");
  assert.equal(parseLiveAddress("ws://[::1]:8787"), "ws://[::1]:8787/");
  assert.equal(parseLiveAddress(LIVE_DEFAULT_ADDRESS), LIVE_DEFAULT_ADDRESS);
  assert.throws(() => parseLiveAddress(""), /Enter the live address/);
  assert.throws(() => parseLiveAddress("   "), /Enter the live address/);
  assert.throws(() => parseLiveAddress("file:///tmp/socket"), /ws:\/\/ or wss:\/\//);
});

test('line reader delivers complete lines across chunk boundaries and skips blanks', () => {
  const lines = [];
  const reader = new LiveLineReader(text => lines.push(text));
  reader.push('{"hello":1}\n{"header"');
  assert.deepEqual(lines, ['{"hello":1}']);
  assert.equal(reader.pending, '{"header"'.length);
  reader.push(':2}\r\n\n{"frame":3}\n');
  assert.deepEqual(lines, ['{"hello":1}', '{"header":2}', '{"frame":3}']);
  assert.equal(reader.pending, 0);
});

test('line reader drops a runaway partial line instead of growing without bound', () => {
  const lines = [];
  const reader = new LiveLineReader(text => lines.push(text), { maxBytes: 16 });
  reader.push("x".repeat(64));
  assert.equal(reader.pending, 0);
  assert.equal(reader.droppedLines, 1);
  reader.push('{"frame":1}\n');
  assert.deepEqual(lines, ['{"frame":1}']);
});

test('a session collects its backlog, then keeps following live frames', () => {
  const buffer = new LiveReplayBuffer();
  const hello = buffer.apply({ hello: { protocol: LIVE_PROTOCOL_VERSION, session: "a", app: "Big Replay", startedAt: "2026-10-08T00:00:00Z" } });
  assert.equal(hello.kind, "hello");
  assert.equal(hello.sessionChanged, true);
  assert.equal(hello.resumed, false);
  assert.equal(hello.mismatch, false);
  assert.equal(buffer.running, true);
  assert.equal(buffer.live, false, "a hello with no frames is not yet watchable");

  buffer.apply({ header: { formatVersion: 1, sampleIntervalSec: 0.1, landmarks: [] } });
  buffer.apply({ frame: { time: 0.1, players: [], gourds: [], monuments: [] } });
  buffer.apply({ events: [{ time: 0.1, type: "run-started" }] });
  buffer.apply({ frame: { time: 0.2, players: [], gourds: [], monuments: [] } });

  assert.equal(buffer.header.sampleIntervalSec, 0.1);
  assert.deepEqual(Array.from(buffer.frames, frame => frame.time), [0.1, 0.2]);
  assert.equal(buffer.events.length, 1);
  assert.equal(buffer.latestTime, 0.2);
  assert.equal(buffer.live, true);

  const bye = buffer.apply({ bye: { reason: "run-ended" } });
  assert.equal(bye.kind, "bye");
  assert.equal(buffer.running, false);
  assert.equal(buffer.live, false);
  assert.equal(buffer.frames.length, 2, "the finished run stays watchable");
});

test('reconnecting to the same run restarts it for the viewer; a new run is a new session', () => {
  const buffer = new LiveReplayBuffer();
  buffer.apply({ hello: { protocol: 1, session: "a" } });
  buffer.apply({ frame: { time: 5 } });
  buffer.apply({ frame: { time: 5.1 } });

  const resumed = buffer.apply({ hello: { protocol: 1, session: "a" } });
  assert.equal(resumed.resumed, true, "the viewer keeps its playhead");
  assert.equal(resumed.sessionChanged, false);
  assert.equal(buffer.frames.length, 0, "the server resends the whole run");

  buffer.apply({ frame: { time: 5 } });
  const next = buffer.apply({ hello: { protocol: 1, session: "b" } });
  assert.equal(next.sessionChanged, true);
  assert.equal(next.resumed, false);
  assert.equal(buffer.frames.length, 0);
});

test('malformed, out-of-order and future messages never corrupt the session', () => {
  const buffer = new LiveReplayBuffer();
  const hello = buffer.apply({ hello: { protocol: LIVE_PROTOCOL_VERSION + 1, session: "x" } });
  assert.equal(hello.mismatch, true);
  assert.equal(buffer.mismatch, true);

  buffer.apply({ frame: { time: 2 } });
  assert.equal(buffer.apply({ frame: { time: 1 } }).skipped, true, "time must not run backwards");
  assert.equal(buffer.apply({ frame: { time: NaN } }).framesAdded, 0);
  assert.equal(buffer.frames.length, 1);
  assert.equal(buffer.apply({ nothing: "we know" }).kind, "unknown");
  assert.equal(buffer.apply(null).kind, "unknown");
  assert.equal(buffer.apply({ events: [{ type: 5 }, null, "x", { time: 1, type: "death" }] }).eventsAdded, 1);
  assert.deepEqual(Array.from(buffer.events, event => event.type), ["death"]);
});

test('client frames JSON lines, counts bad ones, and keeps wanting a live stream after a drop', () => {
  const { client, socket, messages, statuses } = openedClient({ backoff: attempt => (attempt + 1) * 100 });
  assert.equal(socket.url, LIVE_DEFAULT_ADDRESS);
  assert.equal(client.state, "connected");
  assert.equal(statuses[0].state, "connecting");
  assert.equal(statuses.at(-1).state, "connected");

  socket.emitMessage(line({ hello: { protocol: 1, session: "a" } }));
  socket.emitMessage('{"header":{"formatVersion":1}}\n{"frame":{"time":0.1}}\n{"frame":{"ti');
  assert.deepEqual(messages.map(message => Object.keys(message)[0]), ["hello", "header", "frame"]);
  socket.emitMessage('me":0.2}}\n');
  assert.equal(JSON.stringify(messages.at(-1)), '{"frame":{"time":0.2}}', "a split line is reassembled");
  assert.equal(messages.length, 4);

  socket.emitMessage("this is not json\n");
  assert.equal(client.malformedLines, 1);
  assert.equal(client.received, 4, "bad lines are not counted as messages");

  // A message is already framed: a server that forgets the newline must still be delivered.
  socket.emitMessage('{"frame":{"time":0.3}}');
  assert.equal(JSON.stringify(messages.at(-1)), '{"frame":{"time":0.3}}');
  assert.equal(messages.length, 5);

  socket.emitClose(1006);
  assert.equal(client.state, "retrying");
  assert.equal(client.retryDelayMs, 100, "first retry follows the injected schedule");
  assert.equal(statuses.at(-1).state, "retrying");
  assert.match(statuses.at(-1).detail, /No live server answered/);
  assert.equal(socket.closed, false, "a dropped socket is replaced, not closed again");

  client.disconnect();
  assert.equal(client.state, "closed");
  assert.equal(client.timer, null, "disconnecting cancels the pending retry");
});

test('client reports the close instead of retrying when reconnection is off', () => {
  const { client, socket, statuses } = openedClient({ autoReconnect: false });
  socket.emitClose(1000, "restarting");
  assert.equal(client.state, "closed");
  assert.equal(statuses.at(-1).detail, "restarting");
  assert.equal(client.timer, null);

  const refusing = new LiveReplayClient({
    url: "ws://127.0.0.1:8787/",
    WebSocketImpl: class { constructor() { throw new Error("blocked"); } },
    onMessage: () => {},
    onStatus: () => {},
  });
  refusing.connect();
  assert.equal(refusing.state, "retrying", "a refused connection is retried like a drop");
  refusing.disconnect();
});

test('a hello announces how much history this connection will receive', () => {
  const buffer = new LiveReplayBuffer();
  const hello = buffer.apply({ hello: { protocol: 1, session: "a", backlogFrames: 3 } });
  assert.equal(hello.kind, "hello");
  assert.equal(buffer.backlogFrames, 3);
  assert.equal(buffer.pendingBacklog, 3);
  for (const time of [0, 0.1, 0.2]) buffer.apply({ frame: { time } });
  assert.equal(buffer.pendingBacklog, 0, "the live point is reached after the announced history");
  buffer.apply({ frame: { time: 0.3 } });
  assert.equal(buffer.pendingBacklog, 0, "later live frames never make it negative");

  const legacy = new LiveReplayBuffer();
  legacy.apply({ hello: { protocol: 1, session: "b" } });
  assert.equal(legacy.backlogFrames, null, "an older recorder says nothing about the backlog");
  assert.equal(legacy.pendingBacklog, 0);
  assert.equal(new LiveReplayBuffer().pendingBacklog, 0);
});

test('live viewers open at the live point unless they were reviewing', () => {
  assert.equal(liveStartTime({ frontierTime: 613.4 }), 613.4, "a fresh connect starts at the edge");
  assert.equal(liveStartTime({ frontierTime: 613.4, rewindTime: 12 }), 12, "a deliberate rewind is kept");
  assert.equal(liveStartTime({ frontierTime: 613.4, rewindTime: 613.2 }), 613.4, "riding the edge jumps forward");
  assert.equal(liveStartTime({ frontierTime: 613.4, rewindTime: 612.4 }), 613.4, "within a second of the edge counts as live");
  assert.equal(liveStartTime({ frontierTime: 613.4, rewindTime: 612.0 }), 612.0, "further back keeps the review position");
  assert.equal(liveStartTime({}), 0, "nothing received yet");
  assert.equal(liveStartTime({ frontierTime: NaN }), 0);
});

test('reconnect backoff grows to a steady ceiling', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 20].map(liveReconnectDelay), [1000, 2000, 4000, 8000, 10000, 10000, 10000]);
});

test('live mode explains itself when an https page cannot reach a ws:// stream', () => {
  const https = "https:";
  assert.match(liveBlockedReason("ws://127.0.0.1:8787/", https), /block ws:\/\/ .*https page/);
  assert.match(liveBlockedReason("127.0.0.1:8787", https), /block ws:\/\//, "raw addresses are normalized");
  assert.match(liveBlockedReason("http://192.168.1.9:8787/", https), /block ws:\/\//);
  assert.equal(liveBlockedReason("wss://box.example/live", https), null, "a TLS stream is allowed");
  assert.equal(liveBlockedReason("ws://127.0.0.1:8787/", "http:"), null, "plain http pages are fine");
  assert.equal(liveBlockedReason("ws://127.0.0.1:8787/", "file:"), null, "file pages are fine");
  assert.equal(liveBlockedReason("", https), null, "an unusable address is the connect path's problem");
});