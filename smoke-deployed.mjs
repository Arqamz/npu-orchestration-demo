#!/usr/bin/env node
/* Check a DEPLOYED demo, over the network.
 *
 * verify.mjs drives DemoAPI directly against a filesystem. That is the
 * right test for the policy and the field shapes, and it is structurally
 * blind to the thing that actually broke in production: on Cloudflare
 * Pages a missing asset is answered with the project's HTML and a 200, so
 * "the recording is absent" and "here is a page of markup" were the same
 * value. A tenant asking for another tenant's pod logs got 200 and HTML
 * instead of 404.
 *
 * Anything that only exists once deployed belongs in here.
 *
 *   node smoke-deployed.mjs https://npu-orchestration.pages.dev
 */

const BASE = process.argv[2] || 'https://npu-orchestration.pages.dev';

let pass = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

async function call(path, token) {
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  let body = null;
  const text = await res.text();
  try { body = JSON.parse(text); } catch { body = { __raw: text.slice(0, 200) }; }
  return { status: res.status, body, raw: text };
}

console.log(`smoke: ${BASE}\n`);

/* --------------------------------------------------------- the surfaces */

for (const p of ['/', '/console/', '/serving/', '/workspace/', '/tenant/', '/finance/', '/support/']) {
  const res = await fetch(`${BASE}${p}`);
  check(`${p} is served`, res.status === 200, `got ${res.status}`);
  const html = await res.text();
  check(`${p} loads the shared client`, html.includes('/shared/fleet.js'), '');
}
for (const a of ['/shared/fleet.js', '/shared/fleet.css']) {
  const res = await fetch(`${BASE}${a}`);
  check(`${a} is served`, res.status === 200, `got ${res.status}`);
  const type = res.headers.get('content-type') || '';
  check(`${a} has a usable content-type`,
    type.includes('javascript') || type.includes('css'), `got ${type}`);
}

/* ------------------------------------------------------------- the API */

{
  const r = await call('/fleet/me', 'demo-fleet-operator');
  check('operator /fleet/me is 200', r.status === 200, `got ${r.status}`);
  check('operator resolves', r.body?.principal?.operator === true, '');
}
{
  const r = await call('/fleet/nodes', 'demo-fleet-operator');
  check('operator reads the fleet', r.status === 200, `got ${r.status}`);
  check('nodes came back', (r.body?.nodes || []).length > 0, 'the recording did not load');
}
{
  const r = await call('/fleet/nodes', 'demo-acme-engineer');
  check('an engineer is refused the fleet', r.status === 403, `got ${r.status}`);
}
{
  const r = await call('/fleet/usage', null);
  check('no credential is 401', r.status === 401, `got ${r.status}`);
}

/* ------------------------------------------- the bug this file exists for */

{
  // A pod that exists, asked for by a tenant that does not own it.
  const mine = await call('/fleet/endpoints?tenant=maas-co', 'demo-maas-co-admin');
  const pod = (mine.body?.endpoints?.[0]?.replicaDetail || [])[0]?.name;
  check('a replica name is available to test with', Boolean(pod), '');

  if (pod) {
    const ok = await call(`/fleet/logs?tenant=maas-co&pod=${pod}`, 'demo-maas-co-admin');
    check('the owner reads its own logs', ok.status === 200, `got ${ok.status}`);
    check('the owner gets real log lines',
      Array.isArray(ok.body?.lines) && ok.body.lines.length > 0
      && !ok.body.lines[0].includes('<!doctype'),
      'the log body is HTML, so a missing asset is being served as content');

    const theirs = await call(`/fleet/logs?tenant=lab-co&pod=${pod}`, 'demo-lab-co-admin');
    check('another tenant is refused that pod', theirs.status === 404, `got ${theirs.status}`);
    check('the refusal is not an HTML page',
      !JSON.stringify(theirs.body).includes('<!doctype')
      && !JSON.stringify(theirs.body).includes('<html'),
      'Pages served its 404 page as a log body');
  }

  // A route whose recording genuinely does not exist must say so, not
  // return markup.
  const missing = await call('/fleet/billing-export?tenant=nope', 'demo-fleet-operator');
  check('an unrecorded answer is JSON, not HTML',
    !missing.raw.trim().startsWith('<'), 'an HTML page came back from an API route');
}

/* ---------------------------------------------------------- the timeline */

{
  const r = await call('/__demo/timeline/series', 'demo-maas-co-admin');
  check('the timeline loaded in the Worker', (r.body?.series || []).length > 20,
    `got ${(r.body?.series || []).length} frames — check the subrequest limit`);
  const s = r.body?.series || [];
  if (s.length) {
    check('the run reaches the quota ceiling', Math.max(...s.map((f) => f.replicas)) === 4, '');
    check('the run never exceeds it',
      s.every((f) => f.quotaCeiling < 0 || f.replicas <= f.quotaCeiling), '');
    check('the metric moved', Math.max(...s.map((f) => f.observedMetric)) > 1, '');
  }
}

/* -------------------------------------------------------- recursive bill */

{
  const r = await call('/fleet/statements?tenant=dc-shanghai', 'demo-dc-shanghai-admin');
  check('the reseller statement is served', r.status === 200, `got ${r.status}`);
  const resold = r.body?.statements?.[0]?.resold || [];
  check('it carries resold sub-tenants', resold.length > 0, '');
  check('a resold line names its path', Array.isArray(resold[0]?.path), '');
}

/* ------------------------------------------------------------------ done */

console.log('');
if (!failures.length) {
  console.log(`=============== ALL ${pass} DEPLOYED CHECKS PASSED ===============`);
  process.exit(0);
}
console.log(`=============== ${failures.length} OF ${pass + failures.length} FAILED ===============`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(1);
