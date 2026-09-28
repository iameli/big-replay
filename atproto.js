"use strict";

// Atmosphere (atproto) sharing: routes, identity resolution, public record reads,
// and the OAuth-backed account used to publish replays. Reads need no sign-in.
const REPLAY_COLLECTION = "com.iameli.bigWalk.replay";
const REPLAY_FORMAT_JSON_GZ_V1 = "com.iameli.bigWalk.replay#jsonGzV1";
const OAUTH_SCOPE = `atproto repo:${REPLAY_COLLECTION} blob:*/*`;
const PLC_DIRECTORY = "https://plc.directory";
const HANDLE_RESOLVER = "https://public.api.bsky.app";
const PRODUCTION_ORIGIN = "https://big-replay.iame.li";
const ACCOUNT_STORAGE = "big-walk:atproto-account:v1";
const DID_RE = /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/;
const HANDLE_RE = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const RKEY_RE = /^[a-zA-Z0-9._:~-]{1,512}$/;

// ---------- routes ----------
// DIDs always contain ":" and handles always contain ".", so any other first
// segment (e.g. /settings) stays free for future app routes. A full AT-URI in the
// path ("Tynan-linking") also routes, with `redirect` naming the canonical path.
function parseRoute(pathname) {
  const atUri = parseAtUriPath(pathname);
  if (atUri) return atUri;
  const parts = pathname.split("/").filter(Boolean).map(part => {
    try { return decodeURIComponent(part); } catch { return null; }
  });
  if (!parts.length) return { kind: "home" };
  const actor = parts[0];
  if (actor === null || parts.length > 2 || !isActor(actor)) return { kind: "unknown" };
  if (parts.length === 1) return { kind: "actor", actor };
  const rkey = parts[1];
  if (rkey === null || !isRecordKey(rkey)) return { kind: "unknown" };
  return { kind: "replay", actor, rkey };
}

function parseAtUriPath(pathname) {
  let text = pathname.replace(/^\/+/, "");
  try { text = decodeURIComponent(text); } catch { return null; }
  // Some clients and proxies collapse "at://" to "at:/" inside a path.
  const match = /^at:\/\/?(.*)$/i.exec(text);
  if (!match) return null;
  const [actor, collection, rkey, ...rest] = match[1].replace(/\/+$/, "").split("/");
  if (!actor || rest.length || !isActor(actor)) return { kind: "unknown" };
  if (!collection || (collection === REPLAY_COLLECTION && !rkey)) {
    return { kind: "actor", actor, redirect: `/${actor}` };
  }
  if (collection !== REPLAY_COLLECTION || !isRecordKey(rkey)) return { kind: "unknown" };
  return { kind: "replay", actor, rkey, redirect: replayPath(actor, rkey) };
}

function isActor(actor) {
  return actor.includes(":") ? DID_RE.test(actor) && actor.length <= 2048
    : actor.includes(".") && HANDLE_RE.test(actor) && actor.length <= 253;
}

function isRecordKey(rkey) {
  return RKEY_RE.test(rkey) && rkey !== "." && rkey !== "..";
}

function replayPath(did, rkey) {
  return `/${did}/${rkey}`;
}

function replayLink(did, rkey, origin = location.origin) {
  return origin + replayPath(did, rkey);
}

function rkeyFromUri(uri) {
  return uri.split("/").pop();
}

// ---------- records ----------
// atproto records cannot hold floats: durations are integer milliseconds, and
// all positions stay inside the replay blob.
function buildReplayRecord({ blob, title, description, header, players, stats, durationMs, createdAt }) {
  const record = {
    $type: REPLAY_COLLECTION,
    replay: blob,
    format: REPLAY_FORMAT_JSON_GZ_V1,
    createdAt,
  };
  if (title) record.title = title;
  if (description) record.description = description;
  const recordedAt = normalizeDatetime(header?.recordedAt);
  if (recordedAt) record.recordedAt = recordedAt;
  if (Number.isFinite(durationMs)) record.durationMs = Math.max(0, Math.round(durationMs));
  if (typeof header?.gameVersion === "string" && header.gameVersion) record.gameVersion = header.gameVersion.slice(0, 64);
  record.players = players.map(({ netId, name, nickname }) => {
    const player = { netId };
    if (name) player.name = name;
    if (nickname) player.nickname = nickname;
    return player;
  });
  if (stats) record.stats = stats;
  return record;
}

function normalizeDatetime(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Records published before the viewer dropped netId 0 and merged reconnects can
// list those extra entries; count what the viewer now shows.
function recordPlayerCount(record) {
  const names = new Set();
  let unnamed = 0;
  for (const player of record?.players || []) {
    if (player?.netId === 0) continue;
    if (player?.name) names.add(player.name);
    else unnamed++;
  }
  return names.size + unnamed;
}

function recordNicknames(record) {
  const nicknames = new Map();
  for (const player of record?.players || []) {
    if (Number.isInteger(player?.netId) && typeof player.nickname === "string" && player.nickname.trim()) {
      nicknames.set(player.netId, player.nickname.trim());
    }
  }
  return nicknames;
}

function withNickname(record, netId, nickname, name) {
  const players = (record.players || []).map(player => ({ ...player }));
  let player = players.find(entry => entry.netId === netId);
  if (!player) {
    player = { netId };
    if (name) player.name = name;
    players.push(player);
  }
  if (nickname) player.nickname = nickname;
  else delete player.nickname;
  return { ...record, players };
}

// ---------- identity ----------
async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

async function errorMessage(response) {
  try {
    const body = await response.json();
    if (body?.message) return body.message;
    if (body?.error) return body.error;
  } catch { /* Fall back to the HTTP status below. */ }
  return `${response.status} ${response.statusText}`.trim();
}

async function resolveDidDocument(did) {
  if (did.startsWith("did:plc:")) return fetchJson(`${PLC_DIRECTORY}/${encodeURIComponent(did)}`);
  if (did.startsWith("did:web:")) {
    const host = decodeURIComponent(did.slice("did:web:".length));
    if (host.includes(":") && !/^localhost(:\d+)?$/.test(host)) throw new Error(`Unsupported did:web: ${did}`);
    return fetchJson(`https://${host}/.well-known/did.json`);
  }
  throw new Error(`Unsupported DID method: ${did}`);
}

function pdsEndpoint(doc) {
  const service = (doc.service || []).find(entry =>
    (entry.id === "#atproto_pds" || entry.id === `${doc.id}#atproto_pds`) &&
    entry.type === "AtprotoPersonalDataServer");
  if (!service || typeof service.serviceEndpoint !== "string") throw new Error("Account has no PDS");
  return service.serviceEndpoint.replace(/\/+$/, "");
}

function claimedHandle(doc) {
  const aka = (doc.alsoKnownAs || []).find(entry => typeof entry === "string" && entry.startsWith("at://"));
  return aka ? aka.slice("at://".length) : null;
}

async function resolveHandle(handle) {
  const url = `${HANDLE_RESOLVER}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;
  const { did } = await fetchJson(url);
  if (typeof did !== "string" || !DID_RE.test(did)) throw new Error(`Could not resolve @${handle}`);
  return did;
}

// Returns { did, pds, handle }; handle is null unless it resolves back to the DID.
async function resolveActor(actor) {
  const did = actor.startsWith("did:") ? actor : await resolveHandle(actor.toLowerCase());
  const doc = await resolveDidDocument(did);
  if (doc.id !== did) throw new Error(`DID document mismatch for ${did}`);
  const pds = pdsEndpoint(doc);
  let handle = claimedHandle(doc);
  if (handle) {
    if (!actor.startsWith("did:") && handle.toLowerCase() === actor.toLowerCase()) {
      handle = actor.toLowerCase();
    } else {
      try { if (await resolveHandle(handle) !== did) handle = null; } catch { handle = null; }
    }
  }
  return { did, pds, handle };
}

// ---------- public reads ----------
async function getReplayRecord(pds, did, rkey) {
  const params = new URLSearchParams({ repo: did, collection: REPLAY_COLLECTION, rkey });
  return fetchJson(`${pds}/xrpc/com.atproto.repo.getRecord?${params}`);
}

async function listReplayRecords(pds, did, cursor) {
  const params = new URLSearchParams({ repo: did, collection: REPLAY_COLLECTION, limit: "50" });
  if (cursor) params.set("cursor", cursor);
  return fetchJson(`${pds}/xrpc/com.atproto.repo.listRecords?${params}`);
}

function blobUrl(pds, did, cid) {
  const params = new URLSearchParams({ did, cid });
  return `${pds}/xrpc/com.atproto.sync.getBlob?${params}`;
}

function blobCid(blob) {
  return blob?.ref?.$link || blob?.cid || null;
}

// Streams a blob, reporting (loadedBytes, totalBytes | null) as it arrives.
async function downloadBlob(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await errorMessage(response));
  const total = Number(response.headers.get("content-length")) || null;
  if (!response.body) return response.arrayBuffer();
  const reader = response.body.getReader(), chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

// ---------- account (OAuth) ----------
function oauthClientId() {
  const { hostname, port } = location;
  if (hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost") {
    // Loopback development client: metadata is derived from the client_id itself.
    const redirect = `http://${hostname === "localhost" ? "127.0.0.1" : hostname}${port ? `:${port}` : ""}/`;
    return `http://localhost?${new URLSearchParams({ redirect_uri: redirect, scope: OAUTH_SCOPE })}`;
  }
  return `${PRODUCTION_ORIGIN}/oauth-client-metadata.json`;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(script);
  });
}

class AtmosphereAccount extends EventTarget {
  constructor() {
    super();
    this.client = null;
    this.session = null;
    this.did = null;
    this.handle = null;
    this.pds = null;
  }

  // Restores a saved session, or completes a sign-in when this page is the OAuth popup.
  async init() {
    await loadScript("vendor/atproto-oauth.js");
    this.client = await AtprotoOAuth.BrowserOAuthClient.load({
      clientId: oauthClientId(),
      handleResolver: HANDLE_RESOLVER,
      // Also fires for revocations and failed refreshes, including from other tabs.
      onSessionDeleted: sub => { if (sub === this.did) this.setSession(null); },
    });
    const result = await this.client.init();
    if (result?.session) return this.setSession(result.session);
    let savedDid = null;
    try { savedDid = localStorage.getItem(ACCOUNT_STORAGE); } catch { /* Signed out without storage. */ }
    if (!savedDid) return this.setSession(null);
    try {
      return await this.setSession(await this.client.restore(savedDid));
    } catch {
      return this.setSession(null);
    }
  }

  async signIn(handle) {
    const session = await this.client.signInPopup(handle, { scope: OAUTH_SCOPE });
    return this.setSession(session);
  }

  async signOut() {
    const session = this.session;
    await this.setSession(null);
    try { await session?.signOut(); } catch { /* The local session is already gone. */ }
  }

  async setSession(session) {
    this.session = session;
    this.did = session?.did || null;
    this.handle = null;
    this.pds = null;
    try {
      if (this.did) localStorage.setItem(ACCOUNT_STORAGE, this.did);
      else localStorage.removeItem(ACCOUNT_STORAGE);
    } catch { /* Sessions still work for this page without storage. */ }
    if (this.did) {
      try {
        const actor = await resolveActor(this.did);
        this.handle = actor.handle;
        this.pds = actor.pds;
      } catch { /* Handle display is optional; the DID still identifies the account. */ }
    }
    this.dispatchEvent(new Event("change"));
    return session;
  }

  async xrpc(method, { params, body, contentType } = {}) {
    if (!this.session) throw new Error("Sign in first");
    const query = params ? `?${new URLSearchParams(params)}` : "";
    const init = body === undefined ? { method: "GET" } : {
      method: "POST",
      headers: { "content-type": contentType || "application/json" },
      body: contentType ? body : JSON.stringify(body),
    };
    const response = await this.session.fetchHandler(`/xrpc/${method}${query}`, init);
    if (!response.ok) throw new Error(await errorMessage(response));
    return response.status === 204 ? null : response.json();
  }

  async uploadBlob(bytes, mimeType) {
    const { blob } = await this.xrpc("com.atproto.repo.uploadBlob", { body: bytes, contentType: mimeType });
    return blob;
  }

  createReplay(record) {
    return this.xrpc("com.atproto.repo.createRecord", {
      body: { repo: this.did, collection: REPLAY_COLLECTION, record },
    });
  }

  putReplay(rkey, record, swapRecord) {
    const body = { repo: this.did, collection: REPLAY_COLLECTION, rkey, record };
    if (swapRecord) body.swapRecord = swapRecord;
    return this.xrpc("com.atproto.repo.putRecord", { body });
  }

  deleteReplay(rkey) {
    return this.xrpc("com.atproto.repo.deleteRecord", {
      body: { repo: this.did, collection: REPLAY_COLLECTION, rkey },
    });
  }
}
