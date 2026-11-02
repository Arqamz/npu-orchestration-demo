/* The demo control plane.
 *
 * It is a stub in exactly one sense: the bodies it returns were recorded
 * from a real control plane on real Ascend hardware rather than computed
 * now. Everything else is real -- the routes, the bearer authentication,
 * the closed-list scope policy, the status codes, the refusals, and the
 * state that mutations leave behind. A flow that works here works against
 * the Go API, because the parts that decide whether it works are the same
 * parts.
 *
 * What it is NOT: it does not invent data. If a field was never captured,
 * it is absent here too, and that absence is a finding for the design team
 * rather than something to paper over with a plausible number. See
 * docs/API-SURFACE.md for what exists and what does not.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { decide, reach, TENANT_TREE } from './policy.mjs';

/* ---------------------------------------------------------------- tokens */

/* The demo personas. In the real deployment these are Keycloak subjects and
 * the bearer token is an RS256 JWT the manager verifies against the realm's
 * JWKS. Here the token is an opaque string, because a demo that shipped a
 * signing key to a browser would be teaching the wrong lesson -- and the
 * principal each one resolves to is copied from the real /fleet/me the
 * recording captured, so the console sees what it would really see.
 */
export const PERSONAS = {
  'demo-fleet-operator': {
    subject: 'fleet-operator', username: 'fleet-operator',
    name: 'Fleet Operator', email: 'operator@example.internal',
    operator: true, tenantAdmin: false, tenants: [],
    role: 'Data-centre operator',
    blurb: 'Runs the hardware. Sees every node, every tenant and the audit trail.',
  },
  'demo-dc-shanghai-admin': {
    subject: 'dc-shanghai-admin', username: 'dc-shanghai-admin',
    name: 'DC Shanghai', email: 'dc-shanghai-admin@demo.invalid',
    operator: false, tenantAdmin: true, tenants: ['dc-shanghai'],
    role: 'Reseller / data-centre customer',
    blurb: 'Bought capacity and resells it to acme and globex. Sees their usage rolled up.',
  },
  'demo-acme-admin': {
    subject: 'acme-admin', username: 'acme-admin',
    name: 'Acme Admin', email: 'acme-admin@example.internal',
    operator: false, tenantAdmin: true, tenants: ['acme'],
    role: 'Tenant administrator',
    blurb: 'Buys from dc-shanghai, resells again to acme-research. Holds the invoices.',
  },
  'demo-acme-engineer': {
    subject: 'acme-engineer', username: 'acme-engineer',
    name: 'Acme Engineer', email: 'acme-engineer@example.internal',
    operator: false, tenantAdmin: false, tenants: ['acme'],
    role: 'Engineer',
    blurb: 'Submits work and reads logs. Deliberately cannot see billing.',
  },
  'demo-acme-research-admin': {
    subject: 'acme-research-admin', username: 'acme-research-admin',
    name: 'Acme Research', email: 'ar@demo.invalid',
    operator: false, tenantAdmin: true, tenants: ['acme-research'],
    role: 'Sub-sub-tenant',
    blurb: 'Three levels down: dc-shanghai to acme to acme-research.',
  },
  'demo-globex-admin': {
    subject: 'globex-admin', username: 'globex-admin',
    name: 'Globex Admin', email: 'globex-admin@example.internal',
    operator: false, tenantAdmin: true, tenants: ['globex'],
    role: 'Tenant administrator',
    blurb: 'A second customer of the same reseller, for showing isolation.',
  },
  'demo-maas-co-admin': {
    subject: 'maas-co-admin', username: 'maas-co-admin',
    name: 'MaaS Co', email: 'maas-co-admin@demo.invalid',
    operator: false, tenantAdmin: true, tenants: ['maas-co'],
    role: 'Model-as-a-service customer',
    blurb: 'Runs the autoscaling inference endpoint on four cards.',
  },
  'demo-lab-co-admin': {
    subject: 'lab-co-admin', username: 'lab-co-admin',
    name: 'Lab Co', email: 'lab-co-admin@demo.invalid',
    operator: false, tenantAdmin: true, tenants: ['lab-co'],
    role: 'Training customer',
    blurb: 'Runs multi-card training. Shares the fleet with MaaS Co.',
  },
};

/* The recording was captured through each persona's own token, so the
 * fixture directory is named after the subject rather than the token. */
function fixtureDirFor(principal) {
  return principal.subject;
}

/* ------------------------------------------------------------- fixtures */

/** fileFor maps a route to the recorded filename. Mirrors the same
 *  function in scripts/capture-deep-session.sh; if they disagree, every
 *  panel renders an em-dash and the fleet looks empty. */
export function fileFor(pathname, query) {
  let leaf = pathname.replace(/^\/fleet\/?/, '').replace(/\//g, '-') || 'index';
  if (pathname === '/healthz') leaf = 'healthz';
  const keys = [...query.keys()].filter((k) => k !== 'token');
  if (keys.length === 0) return leaf;
  // Named for the parameter, then its value where one was captured per
  // value. The value-suffixed file is preferred and the bare one is the
  // fallback, so a route captured only once still resolves.
  const k = keys[0];
  const v = query.get(k);
  return [`${leaf}-${k}-${v}`, `${leaf}-${k}`, leaf];
}

export class Recordings {
  constructor(root) {
    this.root = root;
    this.cache = new Map();
  }

  async load(persona, pathname, query) {
    const candidates = fileFor(pathname, query);
    const names = Array.isArray(candidates) ? candidates : [candidates];
    for (const name of names) {
      const file = path.join(this.root, persona, `${name}.json`);
      if (!existsSync(file)) continue;
      const key = file;
      if (!this.cache.has(key)) {
        const statusFile = `${file}.status`;
        const status = existsSync(statusFile)
          ? parseInt((await readFile(statusFile, 'utf8')).trim(), 10)
          : 200;
        let body = null;
        try {
          body = JSON.parse(await readFile(file, 'utf8'));
        } catch {
          body = { error: 'the recording is not JSON', file: name };
        }
        this.cache.set(key, { status, body, file: name });
      }
      return this.cache.get(key);
    }
    return null;
  }

  /** Raw pod logs, captured per namespace and pod. */
  async podLog(namespace, pod) {
    const file = path.join(this.root, 'logs', `${namespace}.${pod}.log`);
    if (!existsSync(file)) return null;
    return (await readFile(file, 'utf8')).split('\n');
  }

  async pods(namespace) {
    const file = path.join(this.root, 'logs', `${namespace}.pods.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(await readFile(file, 'utf8'));
  }

  async cluster(kind) {
    const file = path.join(this.root, 'cluster', `${kind}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(await readFile(file, 'utf8'));
  }

  async hardware(name) {
    const file = path.join(this.root, 'hardware', name);
    if (!existsSync(file)) return null;
    return readFile(file, 'utf8');
  }
}

/* ------------------------------------------------- the autoscale timeline */

/* The frames a real autoscaling run produced, replayed in order. This is
 * the one piece of the demo that is time-dependent: an endpoint that only
 * ever shows four replicas is a screenshot, and the product is the
 * movement between one and four and back. */
export class Timeline {
  constructor(root) {
    this.root = root;
    this.frames = [];
    this.meta = null;
    this.startedAt = null;
  }

  async load() {
    const dir = path.join(this.root, 'frames');
    if (!existsSync(dir)) return false;
    const metaFile = path.join(this.root, 'timeline.json');
    if (existsSync(metaFile)) this.meta = JSON.parse(await readFile(metaFile, 'utf8'));
    const files = (await readdir(dir)).filter((f) => /^\d+\.json$/.test(f)).sort();
    for (const f of files) {
      const base = f.replace(/\.json$/, '');
      const offFile = path.join(dir, `${base}.offset`);
      const offset = existsSync(offFile)
        ? parseInt((await readFile(offFile, 'utf8')).trim(), 10)
        : this.frames.length * 5;
      let body;
      try {
        body = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      } catch {
        continue;
      }
      let pods = null;
      const podFile = path.join(dir, `${base}.pods.json`);
      if (existsSync(podFile)) {
        try { pods = JSON.parse(await readFile(podFile, 'utf8')); } catch { pods = null; }
      }
      this.frames.push({ offset, body, pods });
    }
    return this.frames.length > 0;
  }

  /** start the clock. A demo "runs the load test" by calling this.
   *
   * SPEED IS A MULTIPLIER ON RECORDED TIME, NOT A DIFFERENT RUN.
   *
   * The recorded run is 416 seconds. Replaying it at 1:1 means nearly
   * seven minutes of somebody watching a number not change, which is not
   * a demo. At 20x it is 21 seconds.
   *
   * What must NOT compress is the reported time. Every frame keeps its
   * real offset, and the surfaces show "t+258s" rather than wall-clock,
   * because the whole point of this run is that a replica takes four to
   * five minutes to serve. A replay that made it look like twelve
   * seconds would be selling rather than describing -- and the number it
   * would be hiding is the most important one on the page.
   */
  start(speed = 1) {
    this.startedAt = Date.now();
    this.speed = Number(speed) > 0 ? Number(speed) : 1;
    return {
      started: true, frames: this.frames.length, meta: this.meta,
      speed: this.speed, recordedSeconds: this.frames.at(-1)?.offset ?? 0,
    };
  }

  stop() {
    this.startedAt = null;
    return { started: false };
  }

  /** The replay speeds a surface may offer. 1x is kept deliberately:
   *  somebody who does not believe the run can watch it in real time. */
  static SPEEDS = [1, 10, 20, 40];

  /** the frame for the current moment, or the first frame when idle. */
  current() {
    if (!this.frames.length) return null;
    if (this.startedAt === null) return { ...this.frames[0], offset: 0, running: false };
    // Recorded seconds, not wall-clock seconds: the multiplier moves the
    // playhead through the run, and every offset reported stays real.
    const elapsed = ((Date.now() - this.startedAt) / 1000) * (this.speed || 1);
    let chosen = this.frames[0];
    for (const f of this.frames) {
      if (f.offset <= elapsed) chosen = f;
      else break;
    }
    const last = this.frames[this.frames.length - 1];
    const done = elapsed > last.offset;
    return {
      ...chosen, elapsed, running: !done, done,
      speed: this.speed || 1, recordedSeconds: last.offset,
    };
  }

  /** the whole run, for a chart that shows it at once rather than live. */
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

/* ------------------------------------------------------------- mutations */

/* Writes land here rather than in the recordings. A demo in which creating
 * an endpoint does nothing is not showing the flow, and a demo that edits
 * the recordings cannot be reset. */
export class Overlay {
  constructor() {
    this.createdEndpoints = [];
    this.createdJobs = [];
    this.deleted = new Set();
    this.auditExtra = [];
  }

  reset() {
    this.createdEndpoints = [];
    this.createdJobs = [];
    this.deleted = new Set();
    this.auditExtra = [];
  }
}

/* ----------------------------------------------------------------- audit */

/* Every request the demo serves is appended to an in-memory trail with the
 * same shape the real one writes, including the two-phase intent record for
 * a mutation. It is not hash-chained here -- the real chain is in Go and
 * cmd/audit-verify checks it -- but the SHAPE is the real shape, so a
 * console panel built against this renders the real trail unchanged. */
export class DemoAudit {
  constructor(limit = 500) {
    this.records = [];
    this.limit = limit;
    this.seq = 0;
  }

  write(rec) {
    this.seq += 1;
    const full = { seq: this.seq, at: new Date().toISOString(), ...rec };
    this.records.push(full);
    if (this.records.length > this.limit) this.records.shift();
    return full;
  }

  list(tenant) {
    const rows = tenant
      ? this.records.filter((r) => r.tenant === tenant)
      : this.records;
    return [...rows].reverse();
  }
}

/* ------------------------------------------------------------- the router */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class DemoAPI {
  constructor({ recordings, timeline, overlay, audit }) {
    this.rec = recordings;
    this.timeline = timeline;
    this.overlay = overlay ?? new Overlay();
    this.audit = audit ?? new DemoAudit();
  }

  principalFor(authHeader) {
    if (!authHeader) return null;
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (!m) return null;
    return PERSONAS[m[1]] ?? null;
  }

  /** handle is the whole API. Returns {status, body}. */
  async handle(method, pathname, query, headers) {
    const principal = this.principalFor(headers.authorization || headers.Authorization);

    // Demo-only routes, outside the policy because they are not part of
    // the product. Prefixed so they can never be mistaken for one.
    if (pathname.startsWith('/__demo/')) {
      return this.demoRoute(method, pathname, query);
    }

    const askedTenant = query.get('tenant');
    const verdict = decide(pathname, principal, askedTenant);

    // An authentication failure is recorded from the authenticator, not
    // from the middleware, and is marked unauthenticated rather than
    // anonymous -- a rejected credential is the one event that most needs
    // recording. Mirrors the invariant in CLAUDE.md.
    if (!verdict.allow) {
      this.audit.write({
        method, path: pathname,
        caller: principal ? principal.username : 'unknown',
        via: principal ? 'oidc' : 'unauthenticated',
        decision: 'refused',
        status: verdict.status,
        reason: verdict.reason,
        tenant: null,
      });
      return {
        status: verdict.status,
        body: verdict.status === 401
          ? { error: 'unauthenticated', errorDescription: verdict.reason }
          : { error: 'Forbidden', reason: verdict.reason },
      };
    }

    // A mutating call writes its intent BEFORE the handler runs, and is
    // refused if that write fails. One record written afterwards is not
    // enough: between the handler acting and the audit write, the process
    // can be killed and what remains is a change with nothing saying who
    // made it.
    let intent = null;
    if (MUTATING.has(method)) {
      intent = this.audit.write({
        method, path: pathname,
        caller: principal ? principal.username : 'anonymous',
        via: principal ? 'oidc' : 'anonymous',
        decision: 'intent',
        tenant: verdict.tenant,
      });
    }

    const result = await this.route(method, pathname, query, principal, verdict);

    this.audit.write({
      method, path: pathname,
      caller: principal ? principal.username : 'anonymous',
      via: principal ? 'oidc' : 'anonymous',
      decision: result.status < 400 ? 'allowed' : 'failed',
      status: result.status,
      tenant: verdict.tenant,
      intentSeq: intent ? intent.seq : undefined,
    });
    return result;
  }

  async route(method, pathname, query, principal, verdict) {
    if (pathname === '/healthz') return { status: 200, body: { status: 'ok' } };

    if (pathname === '/fleet/me') {
      return {
        status: 200,
        body: {
          authenticated: true,
          principal: {
            subject: principal.subject,
            username: principal.username,
            email: principal.email,
            name: principal.name,
            operator: principal.operator,
            tenantAdmin: principal.tenantAdmin,
            tenants: principal.tenants,
            issuer: 'https://keycloak.demo.invalid/realms/ascend-fleet',
            via: 'oidc',
          },
          // Not in the Go response. Added for the demo's persona switcher
          // and flagged in docs/API-SURFACE.md as a gap, because a portal
          // showing a tenant tree needs it and today has to guess.
          demoReach: reach(principal.tenants || []),
          demoTree: TENANT_TREE,
        },
      };
    }

    if (pathname === '/fleet/logs') return this.logs(query, principal, verdict);
    if (pathname === '/fleet/endpoints') return this.endpoints(method, query, principal, verdict);
    if (pathname === '/fleet/jobs') return this.jobs(method, query, principal, verdict);

    // Everything else replays its recording.
    return this.replay(pathname, query, principal, verdict);
  }

  async replay(pathname, query, principal, verdict) {
    const dir = fixtureDirFor(principal ?? { subject: 'fleet-operator' });
    // Ask for the narrowed form first, then the bare one.
    const q = new URLSearchParams(query);
    if (verdict.tenant) q.set('tenant', verdict.tenant);
    let hit = await this.rec.load(dir, pathname, q);
    if (!hit) hit = await this.rec.load(dir, pathname, new URLSearchParams());

    if (!hit) {
      // An honest miss. The alternative -- synthesising something
      // plausible -- is how a demo ends up showing a product that does
      // not exist.
      return {
        status: 501,
        body: {
          error: 'Not Recorded',
          reason: `no recording for ${pathname} as ${dir}`,
          hint: 'the cluster this was captured from is gone; see docs/API-SURFACE.md',
        },
      };
    }
    return { status: hit.status, body: hit.body };
  }

  async endpoints(method, query, principal, verdict) {
    if (method === 'DELETE') {
      const name = query.get('name');
      if (!name) return { status: 400, body: { error: 'Bad Request', reason: 'name is required' } };
      this.overlay.deleted.add(name);
      this.overlay.createdEndpoints = this.overlay.createdEndpoints.filter((e) => e.name !== name);
      return { status: 204, body: null };
    }

    if (method === 'POST') {
      // The tenant comes from the scoped query, never from the body.
      const tenant = verdict.tenant || (principal.tenants || [])[0];
      if (!tenant) {
        return { status: 400, body: { error: 'Bad Request', reason: 'no tenancy to create in' } };
      }
      const created = {
        name: query.get('name') || 'new-endpoint',
        tenant,
        namespace: `tenant-${tenant}`,
        model: query.get('model') || 'Qwen/Qwen2-0.5B-Instruct',
        image: 'quay.io/ascend/vllm-ascend:v0.18.0',
        resource: 'huawei.com/Ascend910',
        devicesPerReplica: 1,
        minReplicas: 1,
        maxReplicas: parseInt(query.get('maxReplicas') || '4', 10),
        autoscalingEnabled: true,
        metric: 'RunningRequests',
        target: '16',
        phase: 'Pending',
        replicas: 0,
        readyReplicas: 0,
        desiredReplicas: 1,
        quotaCeiling: 4,
        devicesHeld: 0,
        address: '',
        observedMetric: '',
        conditions: [{
          type: 'Available', status: 'False', reason: 'Pending',
          message: 'the model is being pulled; first start takes about four minutes on this hardware',
        }],
        replicaDetail: [],
        createdAt: new Date().toISOString(),
        demoCreated: true,
      };
      this.overlay.createdEndpoints.push(created);
      return { status: 201, body: created };
    }

    // GET. Live frame when the timeline is running, recording otherwise.
    const base = await this.replay('/fleet/endpoints', query, principal, verdict);
    if (base.status !== 200) return base;

    let endpoints = (base.body.endpoints || []).filter((e) => !this.overlay.deleted.has(e.name));

    const tenant = verdict.tenant;
    const frame = this.timeline ? this.timeline.current() : null;
    if (frame && frame.running !== false) {
      const live = (frame.body.endpoints || []);
      endpoints = endpoints.map((e) => {
        const match = live.find((l) => l.name === e.name && l.tenant === e.tenant);
        return match ? { ...match, demoLive: true, demoOffset: frame.offset } : e;
      });
    }

    for (const c of this.overlay.createdEndpoints) {
      if (!tenant || c.tenant === tenant) endpoints.push(c);
    }
    return {
      status: 200,
      body: { endpoints, count: endpoints.length, submitEnabled: base.body.submitEnabled ?? true },
    };
  }

  async jobs(method, query, principal, verdict) {
    if (method === 'DELETE') {
      const name = query.get('name');
      this.overlay.deleted.add(name);
      this.overlay.createdJobs = this.overlay.createdJobs.filter((j) => j.name !== name);
      return { status: 204, body: null };
    }
    if (method === 'POST') {
      const tenant = verdict.tenant || (principal.tenants || [])[0];
      const created = {
        name: query.get('name') || 'new-job',
        tenant,
        namespace: `tenant-${tenant}`,
        queue: `tenant-${tenant}`,
        image: query.get('image') || 'quay.io/ascend/vllm-ascend:v0.18.0',
        resource: 'huawei.com/Ascend910',
        devices: parseInt(query.get('devices') || '1', 10),
        replicas: parseInt(query.get('replicas') || '1', 10),
        active: 0, succeeded: 0, failed: 0,
        phase: 'Pending',
        reason: 'gang scheduling: waiting for the whole group to fit',
        submitter: principal.username,
        createdAt: new Date().toISOString(),
        demoCreated: true,
      };
      this.overlay.createdJobs.push(created);
      return { status: 201, body: created };
    }

    const base = await this.replay('/fleet/jobs', query, principal, verdict);
    if (base.status !== 200) return base;
    let jobs = (base.body.jobs || []).filter((j) => !this.overlay.deleted.has(j.name));
    for (const c of this.overlay.createdJobs) {
      if (!verdict.tenant || c.tenant === verdict.tenant) jobs.push(c);
    }
    return { status: 200, body: { jobs, count: jobs.length, submitEnabled: base.body.submitEnabled ?? true } };
  }

  async logs(query, principal, verdict) {
    const pod = query.get('pod');
    if (!pod) return { status: 400, body: { error: 'Bad Request', reason: 'pod is required' } };
    const tenant = verdict.tenant;
    if (!tenant) {
      return {
        status: 400,
        body: { error: 'Bad Request', reason: 'tenant is required; a pod name alone is not unique across the fleet' },
      };
    }
    const ns = `tenant-${tenant}`;
    const lines = await this.rec.podLog(ns, pod);
    if (!lines) {
      // The same answer the real API gives for a pod in another tenancy:
      // the caller learns it is not theirs and nothing about whose it is.
      return { status: 404, body: { error: 'Not Found', reason: `no pod "${pod}" in tenant "${tenant}"` } };
    }
    const tail = Math.min(parseInt(query.get('tail') || '500', 10) || 500, 10000);
    return {
      status: 200,
      body: {
        pod, tenant, namespace: ns,
        container: query.get('container') || 'server',
        previous: query.get('previous') === 'true',
        tail,
        lines: lines.slice(-tail),
      },
    };
  }

  async demoRoute(method, pathname, query) {
    const leaf = pathname.replace('/__demo/', '');
    if (leaf === 'personas') {
      return {
        status: 200,
        body: Object.entries(PERSONAS).map(([token, p]) => ({
          token, username: p.username, name: p.name, role: p.role,
          blurb: p.blurb, operator: p.operator, tenantAdmin: p.tenantAdmin,
          tenants: p.tenants, reach: reach(p.tenants || []),
        })),
      };
    }
    if (leaf === 'timeline/start' && method === 'POST') {
      // Clamped to the offered set rather than taken as given: an
      // arbitrary multiplier from a query string is a way to make the
      // run look however somebody wants it to look.
      const asked = Number(query?.get?.('speed') ?? 20);
      const speed = Timeline.SPEEDS.includes(asked) ? asked : 20;
      return {
        status: 200,
        body: this.timeline ? this.timeline.start(speed) : { started: false },
      };
    }
    if (leaf === 'timeline/stop' && method === 'POST') {
      return { status: 200, body: this.timeline ? this.timeline.stop() : { started: false } };
    }
    if (leaf === 'timeline/series') {
      return {
        status: 200,
        body: { meta: this.timeline?.meta ?? null, series: this.timeline?.series() ?? [] },
      };
    }
    if (leaf === 'timeline/now') {
      const f = this.timeline?.current();
      return { status: 200, body: f ?? { running: false, frames: 0 } };
    }
    if (leaf === 'audit') {
      return { status: 200, body: { records: this.audit.list(query.get('tenant')) } };
    }
    if (leaf === 'reset' && method === 'POST') {
      this.overlay.reset();
      this.timeline?.stop();
      return { status: 200, body: { reset: true } };
    }
    if (leaf === 'tree') {
      return { status: 200, body: TENANT_TREE };
    }
    if (leaf.startsWith('cluster/')) {
      const kind = leaf.replace('cluster/', '');
      const body = await this.rec.cluster(kind);
      return body ? { status: 200, body } : { status: 404, body: { error: 'Not Recorded' } };
    }
    if (leaf.startsWith('hardware/')) {
      const name = leaf.replace('hardware/', '');
      const text = await this.rec.hardware(name);
      return text ? { status: 200, body: { name, text } } : { status: 404, body: { error: 'Not Recorded' } };
    }
    return { status: 404, body: { error: 'Not Found', reason: `no demo route ${leaf}` } };
  }
}
