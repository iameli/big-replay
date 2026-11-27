"use strict";

function canonicalPlayerNumber(label) {
  const firstWord = String(label || "").trim().split(/\s+/, 1)[0];
  const match = /^P(\d+)$/i.exec(firstWord);
  return match ? Number(match[1]) : null;
}

function canonicalPlayerOrder(playerIds, labelPlayer) {
  return [...playerIds].sort((left, right) => {
    const leftNumber = canonicalPlayerNumber(labelPlayer(left));
    const rightNumber = canonicalPlayerNumber(labelPlayer(right));
    if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber || left - right;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return left - right;
  });
}

// Frame arrays and individual snapshots can be shared by the storage decoder.
// Project only changed entries, preserving that sharing instead of editing history.
function normalizeSnapshots(frames, collection, project) {
  let previous, normalized;
  const replacements = new WeakMap();
  for (const frame of frames) {
    const source = frame[collection];
    if (!source) continue;
    if (source !== previous) {
      let copy = null;
      for (let i = 0; i < source.length; i++) {
        const item = source[i];
        let value = replacements.get(item);
        if (value === undefined) {
          value = project(item);
          if (value !== item) replacements.set(item, value);
        }
        if (value !== item && !copy) copy = source.slice(0, i);
        if (copy && value !== null) copy.push(value);
      }
      previous = source;
      normalized = copy || source;
    }
    frame[collection] = normalized;
  }
}

// Turns recorded netIds into viewer player identities, in place, before anything
// keys on netId (colors, trails, nicknames, shared records).
// - netId 0 is a spawning placeholder: Mirror never assigns it to a real player,
//   and it appears only for single pending frames while others join.
// - A player who disconnects and rejoins gets a new netId. Spans with the same
//   recorded name that never share a frame are one person, so later netIds are
//   rewritten to the first one. Returns Map(canonical netId → all merged netIds).
function normalizeReplayPlayers(replay) {
  const frames = replay.frames, spans = new Map();
  let hasPlaceholders = false;
  frames.forEach((frame, index) => {
    for (const player of frame.players) {
      if (player.netId === 0) { hasPlaceholders = true; continue; }
      let span = spans.get(player.netId);
      if (!span) spans.set(player.netId, span = { netId: player.netId, first: index, last: index, name: "" });
      span.last = index;
      // A name may become readable after the player's first (pending) samples.
      if (!span.name && typeof player.name === "string") span.name = player.name.trim();
    }
  });

  const canonical = new Map(), aliases = new Map(), identities = new Map();
  for (const span of [...spans.values()].sort((a, b) => a.first - b.first || a.netId - b.netId)) {
    if (!span.name) continue;
    const sameName = identities.get(span.name) || [];
    identities.set(span.name, sameName);
    // Only merge when exactly one earlier same-named player has already left.
    const ended = sameName.filter(identity => identity.last < span.first);
    if (ended.length === 1) {
      const identity = ended[0];
      identity.last = span.last;
      canonical.set(span.netId, identity.netId);
      aliases.get(identity.netId).push(span.netId);
    } else {
      sameName.push({ netId: span.netId, last: span.last });
      aliases.set(span.netId, [span.netId]);
    }
  }
  for (const [netId, ids] of aliases) if (ids.length < 2) aliases.delete(netId);

  const remap = netId => canonical.get(netId) ?? netId;
  if (hasPlaceholders || canonical.size) {
    normalizeSnapshots(frames, "players", player => {
      if (player.netId === 0) return null;
      const netId = remap(player.netId);
      return netId === player.netId ? player : { ...player, netId };
    });
  }
  if (canonical.size) {
    normalizeSnapshots(frames, "gourds", gourd => {
      const holderNetId = remap(gourd.holderNetId);
      return holderNetId === gourd.holderNetId ? gourd : { ...gourd, holderNetId };
    });
  }
  if (Array.isArray(replay.events)) {
    replay.events = replay.events.filter(ev =>
      !((ev.type === "player-joined" || ev.type === "player-left") && ev.detail === "0"));
    for (const ev of replay.events) {
      if ((ev.type === "player-joined" || ev.type === "player-left") && ev.detail) {
        ev.detail = String(remap(Number(ev.detail)));
      }
    }
  }
  return aliases;
}
