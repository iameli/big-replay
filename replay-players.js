"use strict";

// Turns recorded netIds into viewer player identities, in place, before anything
// keys on netId (colors, trails, nicknames, shared records).
// - netId 0 is a spawning placeholder: Mirror never assigns it to a real player,
//   and it appears only for single pending frames while others join.
// - A player who disconnects and rejoins gets a new netId. Spans with the same
//   recorded name that never share a frame are one person, so later netIds are
//   rewritten to the first one. Returns Map(canonical netId → all merged netIds).
function normalizeReplayPlayers(replay) {
  const frames = replay.frames, spans = new Map();
  frames.forEach((frame, index) => {
    frame.players = frame.players.filter(player => player.netId !== 0);
    for (const player of frame.players) {
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
  if (canonical.size) {
    for (const frame of frames) {
      for (const player of frame.players) player.netId = remap(player.netId);
      for (const gourd of frame.gourds || []) if (gourd.holderNetId) gourd.holderNetId = remap(gourd.holderNetId);
    }
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
