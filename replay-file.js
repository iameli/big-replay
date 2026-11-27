"use strict";

// File storage only. The live WebSocket still sends complete logical frames.
const REPLAY_ITEM_IDS = { players: "netId", gourds: "name", monuments: "homeName" };

function replayObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function applyReplayPatch(previous, patch, collection) {
  if (patch === undefined) return previous;
  if (!Array.isArray(patch) || patch.length % 2 !== 1) throw new Error(`Invalid ${collection} patch`);
  const length = patch[0];
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff) {
    throw new Error(`Invalid ${collection} length`);
  }
  // Validate the whole patch before allocating. In particular [hugeLength] cannot
  // materialize a sparse array; every new slot must have its own replacement.
  let last = -1, nextAppend = previous.length;
  for (let i = 1; i < patch.length; i += 2) {
    const index = patch[i], item = patch[i + 1];
    if (!Number.isSafeInteger(index) || index <= last || index >= length) {
      throw new Error(`Invalid ${collection} index`);
    }
    if (index >= previous.length && index !== nextAppend++) throw new Error(`Missing ${collection} slot`);
    if (!replayObject(item) || !Number.isInteger(item[REPLAY_ITEM_IDS[collection]])) {
      throw new Error(`Invalid ${collection} replacement`);
    }
    last = index;
  }
  if (nextAppend < length) throw new Error(`Missing ${collection} slot`);
  if (patch.length === 1 && length === previous.length) return previous;
  const result = previous.slice(0, length);
  for (let i = 1; i < patch.length; i += 2) result[patch[i]] = patch[i + 1];
  return result;
}

function decodeReplayLines(bytes, header, start) {
  const frames = [], events = [];
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let previous = { players: [], gourds: [], monuments: [] }, line = 1;
  for (;;) {
    const end = bytes.indexOf(10, start);
    if (end < 0) break; // Commit marker is LF, even if an unterminated tail happens to parse.
    line++;
    try {
      const record = JSON.parse(utf8.decode(bytes.subarray(start, end)));
      if (!replayObject(record) || Object.keys(record).length !== 1) throw new Error("Expected frame or event");
      if (replayObject(record.frame)) {
        const frame = record.frame;
        if (!Number.isFinite(frame.time)) throw new Error("Invalid frame time");
        for (const key of Object.keys(frame)) {
          if (key !== "time" && !Object.hasOwn(REPLAY_ITEM_IDS, key)) throw new Error(`Unknown frame field ${key}`);
        }
        previous = {
          time: frame.time,
          players: applyReplayPatch(previous.players, frame.players, "players"),
          gourds: applyReplayPatch(previous.gourds, frame.gourds, "gourds"),
          monuments: applyReplayPatch(previous.monuments, frame.monuments, "monuments"),
        };
        frames.push(previous);
      } else if (replayObject(record.event)) {
        const event = record.event;
        if (!Number.isFinite(event.time) || typeof event.type !== "string" ||
            (event.detail != null && typeof event.detail !== "string")) throw new Error("Invalid event");
        events.push(event);
      } else throw new Error("Expected frame or event");
    } catch (error) {
      throw new Error(`Replay line ${line}: ${error.message}`);
    }
    start = end + 1;
  }
  return { replay: { header, frames, events }, completeLength: start };
}

// Sniff the payload, not its filename: chooser, dropped files, URLs and AT blobs
// all use the same decoder. A shared record additionally declares gzip + version.
async function decodeReplayFile(buf, expectedVersion = null) {
  let bytes = new Uint8Array(buf);
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (gzipped) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else if (expectedVersion !== null) throw new Error("Expected a gzip replay blob");

  const firstEnd = bytes.indexOf(10);
  let first, replay, version, completeLength = bytes.length;
  if (firstEnd >= 0) {
    try {
      first = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, firstEnd)));
    } catch { /* A pretty-printed v1 document usually begins with just '{'. */ }
  }
  if (first?.header?.formatVersion === 2) {
    if (Object.keys(first).length !== 1) throw new Error("Replay line 1: expected only the v2 header");
    version = 2;
    ({ replay, completeLength } = decodeReplayLines(bytes, first.header, firstEnd + 1));
  } else {
    replay = firstEnd === bytes.length - 1 && first !== undefined ? first :
      JSON.parse(new TextDecoder().decode(bytes));
    if (replay?.header?.formatVersion === 2) throw new Error("Expected a newline-terminated v2 header");
    if (!Array.isArray(replay?.frames)) throw new Error("Expected a v1 replay or v2 JSON Lines header");
    version = 1;
  }
  if (expectedVersion !== null && version !== expectedVersion) throw new Error("Replay blob does not match the record format");
  // A recovered recording must publish only committed records. A gzip file with
  // a complete transport but a partial JSON line must be recompressed on upload.
  const source = completeLength === bytes.length ? { buf, gzipped } :
    { buf: bytes.subarray(0, completeLength), gzipped: false, recovered: true };
  return { replay, source };
}

async function replayUploadBytes(source) {
  if (source.gzipped) return source.buf;
  const stream = new Blob([source.buf]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}
