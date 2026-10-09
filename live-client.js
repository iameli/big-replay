"use strict";

// Live replay streaming, viewer side.
//
// The recorder serves a WebSocket that speaks JSON Lines: one JSON object per line, in publish
// order, using the same shapes as a .replay.json.gz (header, frame, event). A client that
// connects mid-run receives the whole run so far — so it can replay from the start — and then
// keeps receiving frames live on the same socket. `LiveReplayBuffer` is the session state a
// viewer needs; `LiveReplayClient` owns the socket, reconnection and line framing.

const LIVE_PROTOCOL_VERSION = 1;
const LIVE_DEFAULT_ADDRESS = "ws://127.0.0.1:8787/";
const LIVE_MAX_LINE_BYTES = 4 * 1024 * 1024;
const LIVE_RECONNECT_MAX_SECONDS = 10;

/** Normalizes what people paste into a connectable ws:// address. */
function parseLiveAddress(input) {
  const text = String(input ?? "").trim();
  if (!text) throw new Error("Enter the live address shown in Big Replay.");
  let candidate = text;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `ws://${candidate}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`"${text}" is not a valid address.`);
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Live addresses start with ws:// or wss:// (http:// and https:// also work).");
  }
  if (!url.hostname) throw new Error("Live addresses need a host, like ws://127.0.0.1:8787.");
  return url.toString();
}

/** Default reconnect schedule: 1s, 2s, 4s, then 8s, then every 10s. */
function liveReconnectDelay(attempt) {
  return Math.min(LIVE_RECONNECT_MAX_SECONDS, 2 ** Math.min(attempt, 4)) * 1000;
}

/**
 * Browsers refuse `ws://` from a secure page as mixed content, and no client can work around it —
 * the stream would have to be TLS. Returns the explanation when this page cannot reach that
 * address, or null when it can. Live mode therefore needs the viewer opened from a local copy.
 */
function liveBlockedReason(address, pageProtocol) {
  if (pageProtocol !== "https:") return null;
  let url = String(address ?? "");
  try {
    url = parseLiveAddress(url);
  } catch {
    // an unusable address is reported by the connect path itself
  }
  if (!/^ws:\/\//i.test(url)) return null;
  return "Browsers block ws:// live connections from an https page. Open the viewer the recorder "
    + "serves — the address shown in Big Replay's window — and connect from there.";
}

/**
 * Where a live viewer starts: the live point, so connecting shows the run as it happens rather
 * than replaying everything missed. A deliberate rewind survives a dropped socket — the viewer
 * only snaps to the edge when it was actually riding it (or when the recorder starts a new run).
 */
function liveStartTime({ frontierTime, rewindTime = null, tolerance = 1 }) {
  const frontier = Number.isFinite(frontierTime) ? frontierTime : 0;
  if (Number.isFinite(rewindTime) && frontier - rewindTime > tolerance) return rewindTime;
  return frontier;
}

/** Splits a text stream into complete lines, keeping any partial line for the next chunk. */
class LiveLineReader {
  constructor(onLine, { maxBytes = LIVE_MAX_LINE_BYTES } = {}) {
    this.onLine = onLine;
    this.maxBytes = maxBytes;
    this.buffer = "";
    this.droppedLines = 0;
  }

  push(text) {
    if (!text) return;
    this.buffer += text;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
    // A stuck partial line means the stream is not what we think it is; drop it rather than
    // growing without bound. Complete lines are never dropped.
    if (this.buffer.length > this.maxBytes) {
      this.buffer = "";
      this.droppedLines++;
    }
  }

  get pending() { return this.buffer.length; }
}

/**
 * The run a viewer is watching: header, every frame and event received, and whether the stream is
 * still producing frames.
 *
 * A hello always restarts the buffer, because the server resends the whole run on every connect.
 * `sessionChanged` says whether that is a different run (start from the beginning) or the same run
 * replayed (keep the playhead and let it catch up again).
 */
class LiveReplayBuffer {
  constructor() { this.reset(null); }

  reset(sessionId) {
    this.sessionId = sessionId ?? null;
    this.protocol = null;
    this.app = "";
    this.startedAt = null;
    this.header = null;
    this.frames = [];
    this.events = [];
    this.running = false;
    this.byeReason = null;
    this.mismatch = false;
    this.backlogFrames = null;
  }

  /** Frames still expected from the run's history before this connection reaches the live point. */
  get pendingBacklog() {
    return this.backlogFrames === null ? 0 : Math.max(0, this.backlogFrames - this.frames.length);
  }

  get latestTime() {
    const last = this.frames.at(-1);
    return last ? last.time : 0;
  }

  /** True while the buffer holds a complete prefix of a run that is still being recorded. */
  get live() { return this.running && this.frames.length > 0; }

  apply(message) {
    if (!message || typeof message !== "object") return { kind: "unknown" };
    if (message.hello && typeof message.hello === "object") return this.applyHello(message.hello);
    if (message.header && typeof message.header === "object") {
      this.header = message.header;
      return { kind: "header", sessionId: this.sessionId };
    }
    if (message.frame && typeof message.frame === "object") return this.applyFrame(message.frame);
    if (Array.isArray(message.events)) return this.applyEvents(message.events);
    if (message.bye && typeof message.bye === "object") {
      this.running = false;
      this.byeReason = typeof message.bye.reason === "string" ? message.bye.reason : "";
      return { kind: "bye", reason: this.byeReason, sessionId: this.sessionId };
    }
    return { kind: "unknown" };
  }

  applyHello(hello) {
    const sessionId = typeof hello.session === "string" && hello.session ? hello.session : null;
    const sessionChanged = sessionId !== this.sessionId;
    const resumed = !sessionChanged && this.frames.length > 0;
    this.reset(sessionId);
    this.protocol = Number.isInteger(hello.protocol) ? hello.protocol : null;
    this.mismatch = this.protocol !== null && this.protocol !== LIVE_PROTOCOL_VERSION;
    this.app = typeof hello.app === "string" ? hello.app : "";
    this.startedAt = typeof hello.startedAt === "string" ? hello.startedAt : null;
    // How much of the run this connection is about to be sent (absent on older recorders).
    this.backlogFrames = Number.isInteger(hello.backlogFrames) && hello.backlogFrames >= 0
      ? hello.backlogFrames : null;
    this.running = true;
    return { kind: "hello", sessionChanged, resumed, mismatch: this.mismatch, sessionId };
  }

  applyFrame(frame) {
    // Frames are appended in stream order; a timestamp that goes backwards would corrupt the
    // timeline, so it is ignored instead of silently reordering playback.
    const time = frame.time;
    if (!Number.isFinite(time) || (this.frames.length && time < this.latestTime)) {
      return { kind: "frame", framesAdded: 0, skipped: true, sessionId: this.sessionId };
    }
    this.frames.push(frame);
    return { kind: "frame", framesAdded: 1, skipped: false, sessionId: this.sessionId };
  }

  applyEvents(batch) {
    let added = 0;
    for (const item of batch) {
      if (!item || typeof item !== "object" || typeof item.type !== "string") continue;
      this.events.push(item);
      added++;
    }
    return { kind: "events", eventsAdded: added, sessionId: this.sessionId };
  }
}

/**
 * Owns the socket: connects, frames JSON lines, decodes messages, reconnects while the viewer
 * still wants a live stream. It never touches the page.
 */
class LiveReplayClient {
  constructor({
    url, WebSocketImpl = globalThis.WebSocket, onMessage, onStatus, onBadLine = null,
    autoReconnect = true, backoff = liveReconnectDelay,
  }) {
    this.url = parseLiveAddress(url);
    this.WebSocketImpl = WebSocketImpl;
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.onBadLine = onBadLine;
    this.autoReconnect = autoReconnect;
    this.backoff = backoff;
    this.state = "idle";
    this.attempt = 0;
    this.retryDelayMs = 0;
    this.malformedLines = 0;
    this.received = 0;
    this.socket = null;
    this.timer = null;
    this.wanted = false;
    if (typeof this.WebSocketImpl !== "function") {
      throw new Error("This browser cannot open a live connection (no WebSocket support).");
    }
    this.reader = new LiveLineReader(line => this.handleLine(line));
  }

  connect() {
    this.teardown();
    this.wanted = true;
    this.attempt = 0;
    this.open();
  }

  disconnect() {
    this.teardown();
    this.setState("closed");
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.malformedLines++;
      if (this.onBadLine) this.onBadLine(line);
      return;
    }
    this.received++;
    this.onMessage(message);
  }

  handleData(data) {
    if (typeof data === "string") {
      this.pushText(data);
      return;
    }
    // Text frames normally arrive as strings; tolerate binary framing from proxies.
    if (data instanceof ArrayBuffer) {
      this.pushText(new TextDecoder().decode(data));
      return;
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      data.text().then(text => this.pushText(text)).catch(() => {});
    }
  }

  /**
   * WebSocket messages are already framed, so a message without a terminator is one complete
   * line. Without this a server that omits the trailing newline would silently buffer the whole
   * run instead of delivering it.
   */
  pushText(text) {
    this.reader.push(text.includes("\n") ? text : `${text}\n`);
  }

  open() {
    let socket;
    this.setState("connecting");
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch (error) {
      this.retry({ reason: error.message });
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.setState("connected");
    };
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      this.handleData(event.data);
    };
    socket.onerror = () => {
      // A close event always follows; the retry path lives there.
    };
    socket.onclose = event => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.retry({ code: event?.code, reason: event?.reason });
    };
  }

  retry({ code, reason }) {
    if (!this.wanted) {
      this.setState("closed");
      return;
    }
    if (!this.autoReconnect) {
      this.setState("closed", { detail: describeClose(code, reason) });
      return;
    }
    const delayMs = this.backoff(this.attempt);
    this.attempt++;
    this.setState("retrying", { delayMs, detail: describeClose(code, reason) });
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.wanted) this.open();
    }, delayMs);
  }

  teardown() {
    this.wanted = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close();
      } catch (error) {
        // already closing
      }
    }
  }

  setState(state, extra = {}) {
    this.state = state;
    if (typeof extra.delayMs === "number") this.retryDelayMs = extra.delayMs;
    this.onStatus({ state, url: this.url, attempt: this.attempt, ...extra });
  }
}

/** Close codes worth explaining; the browser hides anything else behind "abnormal closure". */
function describeClose(code, reason) {
  if (reason) return reason;
  if (code === 1000) return "The recorder closed the connection.";
  if (code === 1001) return "The recorder is going away.";
  if (code === 1006) {
    return "No live server answered. Start Big Replay, check the address, and that it is still running.";
  }
  if (typeof code === "number") return `Connection closed (${code}).`;
  return "Connection closed.";
}