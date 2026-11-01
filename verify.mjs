#!/usr/bin/env node
/* Check that the demo is actually serving what it claims.
 *
 * The failure this exists for is quiet. A renamed field makes a panel show
 * "—" rather than throwing, so a page that is wrong looks like a fleet that
 * is empty, and nobody notices until it is on a screen in front of Huawei.
 *
 *   node verify.mjs
 *
 * It starts nothing: it drives DemoAPI directly, the same object the HTTP
 * server and the Cloudflare function both wrap.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { DemoAPI, Recordings, Timeline, Overlay, DemoAudit, PERSONAS } from './server/core.mjs';
import { POLICY } from './server/policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { readFile: readFileP } = await import('node:fs/promises');
const SESSION = process.env.SESSION || 'baseline';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass += 1; return; }
  fail += 1;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function report(group) {
  console.log(`\n-- ${group}`);
}

const recordings = new Recordings(path.join(HERE, 'sessions', SESSION));
const timeline = new Timeline(path.join(HERE, 'sessions', 'autoscale'));
const hasTimeline = await timeline.load();

const api = new DemoAPI({
  recordings,
  timeline: hasTimeline ? timeline : null,
  overlay: new Overlay(),
  audit: new DemoAudit(),
});

const get = (p, token, q = '') =>
  api.handle('GET', p, new URLSearchParams(q), { authorization: `Bearer ${token}` });

/* ------------------------------------------------------------- fixtures */

report('recordings');
check('the session directory exists',
  existsSync(path.join(HERE, 'sessions', SESSION)),
  `sessions/${SESSION} is missing`);
check('the autoscale timeline loaded', hasTimeline, 'sessions/autoscale has no frames');
if (hasTimeline) {
  check('the timeline has enough frames to show a run', timeline.frames.length > 20,
    `only ${timeline.frames.length}`);
  const s = timeline.series();
  const peak = Math.max(...s.map((f) => f.replicas));
  const floor = s[s.length - 1].replicas;
  check('the run scales up', peak > 1, `peak replicas ${peak}`);
  check('the run scales back down', floor === 1, `ended at ${floor} replicas`);
  check('the run never exceeds the quota ceiling',
    s.every((f) => f.quotaCeiling < 0 || f.replicas <= f.quotaCeiling),
    'a frame holds more replicas than the tenant bought');
  check('the metric actually moved', Math.max(...s.map((f) => f.observedMetric)) > 1,
    'observedMetric never rose; the load generator did not reach the endpoint');
}

/* --------------------------------------------------------------- policy */

report('policy');
for (const persona of Object.keys(PERSONAS)) {
  const res = await get('/fleet/me', persona);
  check(`${persona} can read /fleet/me`, res.status === 200, `got ${res.status}`);
  check(`${persona} resolves to a principal`,
    res.body?.principal?.username === PERSONAS[persona].username,
    `got ${res.body?.principal?.username}`);
}

// The fleet-wide routes must refuse a tenant, and the refusal must say why.
for (const route of ['/fleet/nodes', '/fleet/clusters', '/fleet/events', '/fleet/compliance']) {
  const res = await get(route, 'demo-acme-engineer');
  check(`${route} refuses an engineer`, res.status === 403, `got ${res.status}`);
  check(`${route} says why`, typeof res.body?.reason === 'string' && res.body.reason.length > 10,
    'the refusal has no usable reason');
}

// The operator reads them.
for (const route of ['/fleet/nodes', '/fleet/clusters']) {
  const res = await get(route, 'demo-fleet-operator');
  check(`${route} serves the operator`, res.status === 200, `got ${res.status}`);
}

// Billing needs the admin grant, with the same tenancy.
{
  const eng = await get('/fleet/invoices', 'demo-acme-engineer');
  check('invoices refuse an engineer', eng.status === 403, `got ${eng.status}`);
  const adm = await get('/fleet/invoices', 'demo-acme-admin', 'tenant=acme');
  check('invoices serve the tenant administrator', adm.status === 200, `got ${adm.status}`);
}

// No credential at all.
{
  const res = await api.handle('GET', '/fleet/usage', new URLSearchParams(), {});
  check('a missing credential is 401', res.status === 401, `got ${res.status}`);
  const bad = await get('/fleet/usage', 'not-a-real-token');
  check('an unknown token is 401', bad.status === 401, `got ${bad.status}`);
}

// A route with no policy entry is refused rather than served.
{
  const res = await get('/fleet/not-a-route', 'demo-fleet-operator');
  check('an unknown route is refused, not served', res.status === 403, `got ${res.status}`);
}

/* ---------------------------------------------------------- cross-tenant */

report('tenant isolation');
{
  const mine = await get('/fleet/endpoints', 'demo-maas-co-admin', 'tenant=maas-co');
  check('maas-co reads its own endpoint', mine.status === 200, `got ${mine.status}`);
  check('maas-co has an endpoint to read',
    (mine.body?.endpoints || []).length === 1,
    `got ${(mine.body?.endpoints || []).length}`);

  const theirs = await get('/fleet/endpoints', 'demo-lab-co-admin', 'tenant=maas-co');
  check('lab-co cannot name maas-co', theirs.status === 403, `got ${theirs.status}`);

  const own = await get('/fleet/endpoints', 'demo-lab-co-admin', 'tenant=lab-co');
  check('lab-co reads its own (empty) endpoint list', own.status === 200, `got ${own.status}`);
  check('lab-co runs no endpoints', (own.body?.endpoints || []).length === 0,
    'lab-co unexpectedly has endpoints');
}

/* ------------------------------------------------------------------ logs */

report('logs');
{
  const eps = await get('/fleet/endpoints', 'demo-maas-co-admin', 'tenant=maas-co');
  const pod = (eps.body?.endpoints?.[0]?.replicaDetail || [])[0]?.name;
  check('the endpoint reports a replica to read logs from', Boolean(pod),
    'replicaDetail is empty, so the workspace log picker has nothing to offer');

  if (pod) {
    const mine = await get('/fleet/logs', 'demo-maas-co-admin', `tenant=maas-co&pod=${pod}`);
    check('a tenant reads its own pod logs', mine.status === 200, `got ${mine.status}`);
    check('the log response carries lines',
      Array.isArray(mine.body?.lines) && mine.body.lines.length > 0,
      'no lines came back');

    const theirs = await get('/fleet/logs', 'demo-lab-co-admin', `tenant=lab-co&pod=${pod}`);
    check('another tenant gets 404 for that pod', theirs.status === 404, `got ${theirs.status}`);
    check('the 404 does not name the owning tenant',
      !JSON.stringify(theirs.body).includes('maas-co'),
      'the refusal leaks whose pod it is');
  }
  const noPod = await get('/fleet/logs', 'demo-maas-co-admin', 'tenant=maas-co');
  check('a missing pod name is 400', noPod.status === 400, `got ${noPod.status}`);
}

/* ------------------------------------------------------------- the shape */

report('field coverage');
{
  const res = await get('/fleet/endpoints', 'demo-maas-co-admin', 'tenant=maas-co');
  const e = res.body?.endpoints?.[0] || {};
  // Every field a surface renders. A rename upstream fails here rather
  // than silently blanking a column.
  for (const f of ['name', 'tenant', 'namespace', 'model', 'image', 'resource',
    'devicesPerReplica', 'minReplicas', 'maxReplicas', 'autoscalingEnabled',
    'metric', 'target', 'phase', 'replicas', 'readyReplicas', 'desiredReplicas',
    'quotaCeiling', 'devicesHeld', 'address', 'observedMetric', 'conditions',
    'replicaDetail', 'createdAt']) {
    check(`endpoint carries ${f}`, f in e, 'the serving page renders this');
  }
  check('conditions carry a human message',
    (e.conditions || []).every((c) => typeof c.message === 'string' && c.message.length > 0),
    'the serving page shows these verbatim');
}
{
  const res = await get('/fleet/nodes', 'demo-fleet-operator');
  const n = res.body?.nodes?.[0] || {};
  for (const f of ['name', 'cluster', 'hardwareClass', 'certifiedStack', 'ready',
    'cordoned', 'remediating', 'faulted']) {
    check(`node carries ${f}`, f in n, 'the console renders this');
  }
}
{
  const res = await get('/fleet/usage', 'demo-fleet-operator');
  const r = res.body?.records?.[0] || {};
  for (const f of ['cluster', 'tenant', 'namespace', 'resource', 'deviceSeconds', 'deviceHours']) {
    check(`usage carries ${f}`, f in r, 'finance and tenancy render this');
  }
}
{
  // The real audit record's own field names. The support page was written
  // against the demo trail's names (at/caller/decision) and the recorded
  // trail uses time/username/outcome -- which renders as a table of
  // em-dashes, i.e. an audit log that looks empty. Pinned here.
  const res = await get('/fleet/audit', 'demo-maas-co-admin', 'tenant=maas-co');
  check('the recorded audit trail is readable', res.status === 200, `got ${res.status}`);
  const r = (res.body?.records || [])[0] || {};
  for (const f of ['seq', 'time', 'username', 'via', 'method', 'path',
    'outcome', 'status', 'tenant', 'hash', 'prev']) {
    check(`audit record carries ${f}`, f in r, 'the support page renders this');
  }
  check('the audit query is redacted of credentials',
    !JSON.stringify(res.body).includes('Bearer '),
    'a bearer token reached the trail');
}
{
  const res = await get('/fleet/statements', 'demo-dc-shanghai-admin', 'tenant=dc-shanghai');
  check('the reseller has a statement', res.status === 200, `got ${res.status}`);
  const s = res.body?.statements?.[0];
  check('the statement carries resold charges', Array.isArray(s?.resold) && s.resold.length > 0,
    'the reseller rollup is the whole recursive-billing story');
  if (s?.resold?.length) {
    check('a resold charge names the path', Array.isArray(s.resold[0].path),
      'finance shows "dc-shanghai → acme"');
    check('a resold charge names the sub-tenant account',
      typeof s.resold[0].accountID === 'string', '');
  }
}

/* ------------------------------------------------------------- mutations */

report('mutations');
{
  const before = await get('/fleet/endpoints', 'demo-maas-co-admin', 'tenant=maas-co');
  const n0 = (before.body.endpoints || []).length;

  const created = await api.handle('POST', '/fleet/endpoints',
    new URLSearchParams('tenant=maas-co&name=verify-ep&model=test/model'),
    { authorization: 'Bearer demo-maas-co-admin' });
  check('creating an endpoint returns 201', created.status === 201, `got ${created.status}`);
  check('the created endpoint is in the caller’s namespace',
    created.body?.namespace === 'tenant-maas-co', `got ${created.body?.namespace}`);

  const after = await get('/fleet/endpoints', 'demo-maas-co-admin', 'tenant=maas-co');
  check('the new endpoint appears in the list',
    (after.body.endpoints || []).length === n0 + 1,
    `${n0} -> ${(after.body.endpoints || []).length}`);

  const del = await api.handle('DELETE', '/fleet/endpoints',
    new URLSearchParams('tenant=maas-co&name=verify-ep'),
    { authorization: 'Bearer demo-maas-co-admin' });
  check('deleting returns 204', del.status === 204, `got ${del.status}`);

  // The body must not be able to choose the tenant. server.mjs folds body
  // fields onto the query, so naming someone else's tenancy reaches the
  // scope layer as ?tenant= and has to be refused there -- not quietly
  // rewritten, which would create the endpoint under the wrong payer.
  const sneaky = await api.handle('POST', '/fleet/endpoints',
    new URLSearchParams('tenant=lab-co&name=sneaky&model=m&image=i'),
    { authorization: 'Bearer demo-maas-co-admin' });
  check('creating under another tenancy is refused', sneaky.status === 403,
    `got ${sneaky.status}; an endpoint would spend lab-co's quota`);
  check('nothing was created under the other tenancy',
    !api.overlay.createdEndpoints.some((e) => e.tenant === 'lab-co'),
    'the refusal did not prevent the write');

  const honest = await api.handle('POST', '/fleet/endpoints',
    new URLSearchParams('tenant=maas-co&name=honest&model=m&image=i'),
    { authorization: 'Bearer demo-maas-co-admin' });
  check('a created endpoint is owned by the scoped tenant',
    honest.body?.tenant === 'maas-co', `got ${honest.body?.tenant}`);
  api.overlay.reset();
}

/* ----------------------------------------------------------------- audit */

report('audit');
{
  const fresh = new DemoAPI({
    recordings, timeline: null, overlay: new Overlay(), audit: new DemoAudit(),
  });
  await fresh.handle('GET', '/fleet/usage', new URLSearchParams(), {});
  await fresh.handle('POST', '/fleet/endpoints',
    new URLSearchParams('tenant=maas-co&name=a'),
    { authorization: 'Bearer demo-maas-co-admin' });

  const rows = fresh.audit.list();
  check('a rejected credential is recorded',
    rows.some((r) => r.via === 'unauthenticated'),
    'the one event that most needs recording was dropped');
  check('a mutation writes an intent record before the result',
    rows.some((r) => r.decision === 'intent'),
    'two-phase write is not happening');
  const intent = rows.find((r) => r.decision === 'intent');
  const done = rows.find((r) => r.intentSeq === intent?.seq);
  check('the result record links back to its intent', Boolean(done), '');
  check('sequence numbers are dense and increasing',
    fresh.audit.records.every((r, i) => r.seq === i + 1), '');
}

/* ----------------------------------------------- every recorded route has a policy */

report('policy covers the recordings');
{
  const seen = new Set();
  for (const persona of Object.values(PERSONAS)) {
    const dir = path.join(HERE, 'sessions', SESSION, persona.subject);
    if (!existsSync(dir)) continue;
    const { readdir, readFile } = await import('node:fs/promises');
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      const leaf = f.replace(/\.json$/, '').split('-')[0];
      seen.add(leaf);
    }
  }
  // Each recorded leaf must map to a policy entry under /fleet, with the
  // two known non-/fleet names allowed through.
  for (const leaf of seen) {
    if (['index', 'healthz', 'refusals'].includes(leaf)) continue;
    const route = `/fleet/${leaf}`;
    const known = route in POLICY || Object.keys(POLICY).some((p) => p.startsWith(route));
    check(`recorded route ${route} has a scope`, known,
      'a recording exists for a route the demo policy would refuse');
  }
}

/* ------------------------------------------------- the pages themselves */

/* A page with a syntax error is served with a 200 and renders nothing: the
 * module fails to parse, the error goes to a console nobody has open, and
 * the surface looks like a fleet with no data in it. smoke-deployed.mjs
 * checks that pages are SERVED; this checks that they PARSE. */
report('pages parse');
{
  const { readdir, readFile } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const WEB = path.join(HERE, 'web');
  const scratch = await mkdtemp(path.join(tmpdir(), 'ascend-verify-'));

  /* `node --check` on a real .mjs file.
   *
   * Not vm.SourceTextModule, which needs --experimental-vm-modules: a
   * verifier that only runs with a flag is a verifier nobody runs. Not
   * --input-type=module over stdin either -- execFile has no `input`
   * option, so the child waits on a stdin that never closes and the whole
   * run hangs. */
  let seq = 0;
  function parses(source, label) {
    const file = path.join(scratch, `check-${seq += 1}.mjs`);
    try {
      writeFileSync(file, source);
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      return null;
    } catch (err) {
      const msg = String(err.stderr || err.message).split('\n')
        .find((l) => l.includes('Error')) || String(err.message);
      return `${label}: ${msg.slice(0, 120)}`;
    }
  }

  async function pagesIn(dir) {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...await pagesIn(full));
      else if (e.name.endsWith('.html')) out.push(full);
    }
    return out;
  }

  const pages = await pagesIn(WEB);
  check('every surface has a page', pages.length >= 7, `found ${pages.length}`);

  for (const p of pages) {
    const html = await readFile(p, 'utf8');
    const rel = path.relative(HERE, p);

    const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
    check(`${rel} has a module script`, Boolean(m), '');
    if (!m) continue;
    const err = parses(m[1], rel);
    check(`${rel} parses`, err === null, err || '');
    // FOUND THE HARD WAY. `node --check` is a parse, and a temporal dead
    // zone is not a parse error: the serving page declared `let chart`
    // below the block that assigned it, parsed clean, rendered its header
    // and threw on first assignment -- which looks exactly like an
    // endpoint with no data, the same quiet failure as every other one in
    // this project.
    //
    // A heuristic, not a scope analysis: a bare `name = ...` at the start
    // of a line, where `let name` / `const name` appears later in the same
    // module. That is the shape the bug took and it is cheap to refuse.
    const tdz = useBeforeDeclare(m[1]);
    check(`${rel} has no use-before-declare`, tdz === null,
      tdz ? `${tdz} is assigned before its declaration` : '');

    // Every page must declare a viewport, or it is unreadable on a phone
    // and nobody notices until it is on one.
    check(`${rel} declares a viewport`, html.includes('name="viewport"'), '');
    check(`${rel} loads the stylesheet`, html.includes('/shared/fleet.css'), '');
  }

  for (const f of ['web/shared/fleet.js', 'server/core.mjs', 'server/policy.mjs',
    'functions/_middleware.js']) {
    const src = await readFile(path.join(HERE, f), 'utf8');
    const err = parses(src, f);
    check(`${f} parses`, err === null, err || '');
  }
  await rm(scratch, { recursive: true, force: true });
}


/** useBeforeDeclare finds a top-level `name = ...` that precedes the
 *  `let name` / `const name` declaring it. Returns the name, or null.
 *
 *  Deliberately a heuristic over module-scope lines rather than a scope
 *  analysis: it catches the shape the real bug took without pulling in a
 *  parser, and a false positive is fixed by moving a declaration up, which
 *  is where it belonged anyway. */
function useBeforeDeclare(source) {
  const lines = source.split('\n');
  const declaredAt = new Map();
  const assignedAt = new Map();

  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '');
    const decl = /^(?:let|const|var)\s+([A-Za-z_$][\w$]*)/.exec(line.trim());
    if (decl && !declaredAt.has(decl[1])) declaredAt.set(decl[1], i);
    // A bare assignment at module scope: no indentation beyond two spaces,
    // no keyword, not a comparison, not a property.
    const asg = /^\s{0,4}([A-Za-z_$][\w$]*)\s*=\s*[^=]/.exec(line);
    if (asg && !/^\s*(?:let|const|var|if|for|while|return)\b/.test(line)) {
      if (!assignedAt.has(asg[1])) assignedAt.set(asg[1], i);
    }
  });

  for (const [name, at] of assignedAt) {
    const d = declaredAt.get(name);
    if (d !== undefined && d > at) return name;
  }
  return null;
}

/* ------------------------------------------------------------ stylesheet */

report('every class a page uses is actually styled');

/* Every surface, by path under web/. Named once rather than globbed, so
 * adding a page without adding it here is a visible omission rather than
 * a silently unchecked file. */
const PAGES = [
  'index.html', 'console/index.html', 'serving/index.html',
  'workspace/index.html', 'tenant/index.html', 'finance/index.html',
  'support/index.html',
];

/* THE REGRESSION THIS CATCHES.
 *
 * Rewriting the design system dropped twelve class names the surfaces
 * were still using. Nothing failed: CSS silently ignores a class it has
 * no rule for, so the pages rendered as unstyled blocks and every other
 * check in this file went on passing. A page that is WRONG looks like a
 * fleet that is EMPTY, which is the failure mode this whole verifier
 * exists to stop -- and it had a hole exactly where the styling was.
 *
 * Deliberately a name-level check rather than a selector-matching one.
 * Resolving real CSS specificity would need a parser and would be a
 * second implementation of a browser; "there is at least one rule
 * mentioning this class" catches a dropped component without pretending
 * to more precision than it has.
 */
{
  const selectorClasses = (css) => {
    const out = new Set();
    // Strip comments and at-rule preludes, then take every selector.
    const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of body.matchAll(/([^{}]+)\{/g)) {
      const sel = m[1];
      if (sel.trimStart().startsWith('@')) continue;
      for (const c of sel.matchAll(/\.([a-zA-Z0-9_-]+)/g)) out.add(c[1]);
    }
    return out;
  };

  const sheet = await readFileP(path.join(HERE, 'web/shared/fleet.css'), 'utf8');
  const styled = selectorClasses(sheet);

  for (const page of PAGES) {
    const html = await readFileP(path.join(HERE, 'web', page), 'utf8');
    const used = new Set();
    for (const m of html.matchAll(/class: *'([^']*)'/g)) {
      for (const c of m[1].split(/\s+/)) if (c) used.add(c);
    }
    for (const m of html.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) if (c) used.add(c);
    }
    // A page may carry its own <style>; those classes are styled too.
    const own = new Set();
    for (const m of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
      for (const c of selectorClasses(m[1])) own.add(c);
    }
    const orphans = [...used].filter((c) => !styled.has(c) && !own.has(c)).sort();
    check(`${page}: every class it uses has a rule`, orphans.length === 0,
      orphans.length ? `no rule for: ${orphans.join(', ')}` : '');
  }
}

report('the guided tour is wired on every surface');

/* A tour nobody can replay is a tour that runs once and is gone. Every
 * surface must define one, offer it on a first visit, and keep a visible
 * way back to it. */
{
  for (const page of PAGES) {
    const html = await readFileP(path.join(HERE, 'web', page), 'utf8');
    if (page === 'index.html') continue; // the pitch page explains itself
    check(`${page}: defines a tour`, html.includes('new Tour('));
    check(`${page}: offers it on a first visit`, html.includes('tour.offer()'));
    check(`${page}: keeps a way to replay it`, html.includes('launcher(tour'));
    check(`${page}: opens with a lede rather than a bare title`,
      html.includes('lede({'));
  }
}

/* ---------------------------------------------------------------- report */

console.log('');
if (fail === 0) {
  console.log(`=============== ALL ${pass} CHECKS PASSED ===============`);
  process.exit(0);
}
console.log(`=============== ${fail} OF ${pass + fail} CHECKS FAILED ===============`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(1);
