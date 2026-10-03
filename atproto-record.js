"use strict";

class AtprotoRecordRoute {
  constructor(section, status, uriElement, valueElement) {
    this.section = section;
    this.status = status;
    this.uriElement = uriElement;
    this.valueElement = valueElement;
    this.request = null;
    addEventListener("hashchange", () => this.loadHash());
    this.loadHash();
  }

  async loadHash() {
    const raw = location.hash.slice(1);
    if (!raw.startsWith("at://")) {
      this.request?.abort();
      this.request = null;
      this.section.hidden = true;
      this.valueElement.textContent = "";
      return;
    }

    this.section.hidden = false;
    this.section.open = true;
    let record;
    try {
      record = this.parseUri(raw);
    } catch (error) {
      this.status.textContent = error.message;
      this.uriElement.textContent = raw;
      this.valueElement.textContent = "";
      return;
    }

    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.uriElement.textContent = record.uri;
    this.status.textContent = "Loading record…";
    this.valueElement.textContent = "";

    try {
      const { body, host } = await this.fetchRecord(record, request.signal);
      if (request !== this.request) return;
      this.uriElement.textContent = body.uri || record.uri;
      this.status.textContent = body.cid ? `Record loaded from ${host} · CID ${body.cid}` : `Record loaded from ${host}.`;
      this.valueElement.textContent = JSON.stringify(body.value, null, 2);
    } catch (error) {
      if (error.name === "AbortError" || request !== this.request) return;
      this.status.textContent = error.message;
      this.valueElement.textContent = "";
    }
  }

  async fetchRecord(record, signal) {
    let identity;
    try {
      identity = await resolveActor(record.repo);
      if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
    } catch (error) {
      if (error.name === "AbortError") throw error;
    }
    const service = identity?.pds || "https://public.api.bsky.app";
    const repo = identity?.did || record.repo;
    const endpoint = new URL("/xrpc/com.atproto.repo.getRecord", service);
    endpoint.searchParams.set("repo", repo);
    endpoint.searchParams.set("collection", record.collection);
    endpoint.searchParams.set("rkey", record.rkey);
    const response = await fetch(endpoint, { signal });
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = body.message || body.error || "";
      } catch { /* The HTTP status remains useful when the body is not JSON. */ }
      throw new Error(`Could not load AT Protocol record (${response.status})${detail ? `: ${detail}` : "."}`);
    }
    return { body: await response.json(), host: endpoint.host };
  }

  parseUri(raw) {
    const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/?#]+)$/.exec(raw);
    if (!match) throw new Error("Expected #at://<repo>/<collection>/<record-key>.");
    let repo, collection, rkey;
    try {
      [, repo, collection, rkey] = match.map(part => decodeURIComponent(part));
    } catch {
      throw new Error("AT URI contains invalid percent encoding.");
    }
    if (!repo || !collection.includes(".") || !rkey) {
      throw new Error("AT URI must include a repository, collection NSID, and record key.");
    }
    return { repo, collection, rkey, uri: `at://${repo}/${collection}/${rkey}` };
  }
}
