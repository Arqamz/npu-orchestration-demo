/* The deployed demo's backend.
 *
 * Cloudflare Pages Functions, wrapping exactly the same DemoAPI the local
 * server wraps. There is one implementation of the policy, the scoping and
 * the refusals; this file only adapts Request to the arguments core.mjs
 * already takes.
 *
 * The recordings are fetched from the deployed static assets rather than
 * read off a disk, because a Function has no filesystem. That is the whole
 * difference between this and server/server.mjs.
 */

import { DemoAPI, Overlay, DemoAudit } from '../server/core.mjs';
import { decide } from '../server/policy.mjs';

/* A Recordings that reads through the Pages asset fetcher. Same three
 * methods core.mjs calls; the constructor takes the env binding instead of
 * a directory. */
class AssetRecordings {
  constructor(env, origin, session) {
    this.env = env;
    this.origin = origin;
    this.session = session;
    this.cache = new Map();
  }

  /* A MISS MUST BE A MISS.
   *
   * Pages answers a path it does not have by serving the project's HTML --
   * with a 200. So `res.ok` is not "the file exists", and the first
   * deployed version took that HTML as a log body: a tenant asking for
   * another tenant's pod got 200 and a page of markup instead of the 404
   * the policy requires. The local server has a filesystem and cannot
   * reproduce this, which is why it reached production.
   *
   * Anything that is HTML, or is not a 200, is treated as absent. */
  async fetchAsset(rel) {
    const url = `${this.origin}/sessions/${this.session}/${rel}`;
    const res = await this.env.ASSETS.fetch(new Request(url));
    if (res.status !== 200) return null;
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/html')) return null;
    const text = await res.text();
    // Belt and braces: a misconfigured content-type should not be able to
    // turn a 404 page into a tenant's logs.
    if (/^\s*<(!doctype|html)/i.test(text)) return null;
    return text;
  }

  async fetchJSON(rel) {
    const url = `${this.origin}/sessions/${this.session}/${rel}`;
    if (this.cache.has(url)) return this.cache.get(url);
    const text = await this.fetchAsset(rel);
    let out = null;
    if (text !== null) { try { out = JSON.parse(text); } catch { out = null; } }
    this.cache.set(url, out);
    return out;
  }

  async fetchText(rel) {
    return this.fetchAsset(rel);
  }

  async load(persona, pathname, query) {
    const { fileFor } = await import('../server/core.mjs');
    const candidates = fileFor(pathname, query);
    const names = Array.isArray(candidates) ? candidates : [candidates];
    for (const name of names) {
      const body = await this.fetchJSON(`${persona}/${name}.json`);
      if (body === null) continue;
      // The status files are tiny; a miss means 200, as in the recorder.
      const statusText = await this.fetchText(`${persona}/${name}.json.status`);
      const status = statusText ? parseInt(statusText.trim(), 10) : 200;
      return { status, body, file: name };
    }
    return null;
  }

  async podLog(namespace, pod) {
    const text = await this.fetchText(`logs/${namespace}.${pod}.log`);
    return text === null ? null : text.split('\n');
  }

  async pods(namespace) {
    return this.fetchJSON(`logs/${namespace}.pods.json`);
  }

  async cluster(kind) {
    return this.fetchJSON(`cluster/${kind}.json`);
  }

  async hardware(name) {
    const text = await this.fetchText(`hardware/${name}`);
    return text;
  }
}

/* The timeline, loaded from the deployed frames. Mirrors server/core.mjs's
 * Timeline but fetches rather than reads. The state it keeps -- when the
 * replay was started -- lives per isolate, which is correct for a demo:
 * each viewer drives their own run. */
class AssetTimeline {
  constructor(env, origin) {
    this.env = env;
    this.origin = origin;
    this.frames = [];
    this.meta = null;
    this.startedAt = null;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this.frames.length > 0;
    this.loaded = true;
    const base = `${this.origin}/sessions/autoscale`;
    const metaRes = await this.env.ASSETS.fetch(new Request(`${base}/timeline.json`));
    if (!metaRes.ok) return false;
    this.meta = await metaRes.json();
    // ONE fetch, not one per frame. The first deployed version walked the
    // manifest and fetched each frame, which is 160 subrequests against a
    // Worker limit of 50 -- so every API call, including ones that never
    // touch the timeline, failed with "Too many subrequests". build.mjs
    // writes the bundle for exactly this reason.
    const res = await this.env.ASSETS.fetch(new Request(`${base}/frames.bundle.json`));
    if (!res.ok) return false;
    const bundle = await res.json().catch(() => null);
    if (!Array.isArray(bundle)) return false;
    this.frames = bundle;
    return this.frames.length > 0;
  }

  start() { this.startedAt = Date.now(); return { started: true, frames: this.frames.length, meta: this.meta }; }
  stop() { this.startedAt = null; return { started: false }; }

  current() {
    if (!this.frames.length) return null;
    if (this.startedAt === null) return { ...this.frames[0], offset: 0, running: false };
    const elapsed = (Date.now() - this.startedAt) / 1000;
    let chosen = this.frames[0];
    for (const f of this.frames) {
      if (f.offset <= elapsed) chosen = f; else break;
    }
    const last = this.frames[this.frames.length - 1];
    const done = elapsed > last.offset;
    return { ...chosen, elapsed, running: !done, done };
  }

  series() {
    return this.frames.map((f) => {
      const e = (f.body.endpoints || [])[0] || {};
      return {
        offset: f.offset,
        replicas: e.replicas ?? 0,
        readyReplicas: e.readyReplicas ?? 0,
        devicesHeld: e.devicesHeld ?? 0,
        quotaCeiling: e.quotaCeiling ?? 0,
        observedMetric: parseFloat(e.observedMetric ?? '0'),
        phase: e.phase ?? '',
        conditions: e.conditions ?? [],
      };
    });
  }
}

/* One API per isolate. Rebuilding it per request would re-fetch eighty
 * frames on every poll of the serving page. */
let cached = null;

async function apiFor(env, origin) {
  if (cached) return cached;
  const session = env.SESSION || 'baseline';
  const recordings = new AssetRecordings(env, origin, session);
  const timeline = new AssetTimeline(env, origin);
  const ok = await timeline.load();
  cached = new DemoAPI({
    recordings,
    timeline: ok ? timeline : null,
    overlay: new Overlay(),
    audit: new DemoAudit(),
  });
  return cached;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  const isAPI = url.pathname.startsWith('/fleet')
    || url.pathname === '/healthz'
    || url.pathname.startsWith('/__demo/');

  if (!isAPI) return next();

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Cache-Control': 'no-store',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  // Body fields fold onto the query, as in the local server, so that a
  // tenant named in a body still has to pass the scope layer.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      const parsed = await request.clone().json();
      for (const [k, v] of Object.entries(parsed)) {
        if (v !== null && typeof v !== 'object') url.searchParams.set(k, String(v));
      }
    } catch { /* a non-JSON body is ignored */ }
  }

  const headers = {};
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;

  try {
    const api = await apiFor(env, url.origin);
    const { status, body } = await api.handle(
      request.method, url.pathname, url.searchParams, headers,
    );
    if (status === 204) return new Response(null, { status: 204, headers: cors });
    return new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Internal', reason: String(err && err.stack || err) }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}

export { decide };
