#!/usr/bin/env node
/* Generate the API surface document from the recordings themselves.
 *
 * Hand-written API docs drift, and a drifted doc is worse than none: a
 * designer builds a screen around a field that was renamed a month ago and
 * nobody finds out until it renders blank. So this is generated. Every
 * route, every field, every type and every status below was read out of a
 * real captured response.
 *
 *   node describe-api.mjs > docs/API-SURFACE.md
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { POLICY } from './server/policy.mjs';
import { PERSONAS } from './server/core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION = process.env.SESSION || 'baseline';
const ROOT = path.join(HERE, 'sessions', SESSION);

/* ----------------------------------------------------------- shape walk */

/** describe reduces a value to a type name, recursing into objects and the
 *  first element of arrays. Arrays of objects are merged across ALL their
 *  elements, because the first row is frequently the one without the
 *  optional field, and a designer who sees only that builds a column that
 *  is sometimes blank for reasons nobody can explain. */
function describe(v) {
  if (v === null) return { type: 'null' };
  if (Array.isArray(v)) {
    if (!v.length) return { type: 'array', of: { type: 'unknown (empty in this recording)' } };
    const objs = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length) {
      const merged = {};
      for (const o of objs) {
        for (const [k, val] of Object.entries(o)) {
          if (!(k in merged)) merged[k] = describe(val);
          else if (merged[k].type === 'null' && val !== null) merged[k] = describe(val);
        }
      }
      // A key missing from some elements is optional, and saying so is the
      // whole point.
      for (const k of Object.keys(merged)) {
        const present = objs.filter((o) => k in o && o[k] !== null).length;
        merged[k].optional = present < objs.length;
        merged[k].presentIn = `${present}/${objs.length}`;
        const sample = objs.find((o) => o[k] !== null && o[k] !== undefined);
        if (sample) merged[k].example = sampleOf(sample[k]);
      }
      return { type: 'array', of: { type: 'object', fields: merged } };
    }
    return { type: 'array', of: describe(v[0]), example: sampleOf(v[0]) };
  }
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) {
      fields[k] = describe(val);
      fields[k].example = sampleOf(val);
    }
    return { type: 'object', fields };
  }
  return { type: typeof v };
}

function sampleOf(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.length > 70 ? `${v.slice(0, 67)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return `[${v.length} items]`;
  return '{…}';
}

/* ---------------------------------------------------------- the capture */

const personaDirs = Object.values(PERSONAS).map((p) => p.subject);

/** Every recorded file, grouped by the route it represents. */
async function collect() {
  const routes = new Map();
  for (const persona of personaDirs) {
    const dir = path.join(ROOT, persona);
    if (!existsSync(dir)) continue;
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      const name = f.replace(/\.json$/, '');
      const statusFile = path.join(dir, `${f}.status`);
      const status = existsSync(statusFile)
        ? parseInt((await readFile(statusFile, 'utf8')).trim(), 10) : 200;
      const raw = await readFile(path.join(dir, f), 'utf8');
      let body = null;
      let isJSON = true;
      try { body = JSON.parse(raw); } catch {
        // NOT skipped. A route that answers with something other than JSON
        // is a finding -- /healthz is in the policy as public and the
        // inventory API returns a plain-text 404 for it, because the route
        // is registered on a different server. Dropping the capture here
        // is how that stayed invisible.
        isJSON = false;
        body = { __nonJSON: raw.trim().slice(0, 200) };
      }

      // Recover the route from the filename: "usage-tenant-acme" ->
      // /fleet/usage with ?tenant=acme.
      const { route, params } = routeOf(name);
      if (!routes.has(route)) routes.set(route, { route, observations: [], shape: null });
      const entry = routes.get(route);
      entry.observations.push({
        persona, status, params, file: f, isJSON,
        size: raw.length,
      });
      if (!isJSON) entry.nonJSON = body.__nonJSON;
      if (status === 200 && !entry.shape) entry.shape = describe(body);
      // Prefer the richest 200 we saw: an empty list teaches nobody anything.
      if (status === 200 && entry.shape) {
        const richer = JSON.stringify(body).length;
        if (richer > (entry.shapeSize || 0)) {
          entry.shape = describe(body);
          entry.shapeSize = richer;
          entry.shapeFrom = persona;
        }
      }
    }
  }
  return routes;
}

function routeOf(name) {
  if (name === 'index') return { route: '/fleet', params: null };
  if (name === 'healthz') return { route: '/healthz', params: null };
  if (name.startsWith('refusals')) return { route: '(refusal shapes)', params: null };

  // Known multi-segment routes first, longest match wins.
  const multi = ['audit-verify', 'audit-checkpoint', 'audit-pubkey', 'audit-proof', 'audit-consistency'];
  for (const m of multi) {
    if (name === m || name.startsWith(`${m}-`)) {
      const rest = name.slice(m.length).replace(/^-/, '');
      return { route: `/fleet/${m.replace('-', '/')}`, params: rest || null };
    }
  }
  const known = ['billing-export'];
  for (const k of known) {
    if (name === k || name.startsWith(`${k}-`)) {
      const rest = name.slice(k.length).replace(/^-/, '');
      return { route: `/fleet/${k}`, params: rest || null };
    }
  }
  const parts = name.split('-');
  const leaf = parts[0];
  const rest = parts.slice(1).join('-');
  return { route: `/fleet/${leaf}`, params: rest || null };
}

/* ------------------------------------------------------------- printing */

function fieldTable(fields, depth = 0, out = []) {
  const pad = '  '.repeat(depth);
  for (const [k, v] of Object.entries(fields)) {
    const flag = v.optional ? ` _(optional, present in ${v.presentIn})_` : '';
    const ex = v.example === null || v.example === undefined ? ''
      : ` — e.g. \`${String(v.example).replace(/\|/g, '\\|')}\``;
    out.push(`${pad}- \`${k}\` · ${v.type}${flag}${ex}`);
    if (v.type === 'object' && v.fields) fieldTable(v.fields, depth + 1, out);
    if (v.type === 'array' && v.of?.type === 'object' && v.of.fields) {
      out.push(`${pad}  each item:`);
      fieldTable(v.of.fields, depth + 2, out);
    }
  }
  return out;
}

const routes = await collect();
const sorted = [...routes.values()].sort((a, b) => a.route.localeCompare(b.route));

const L = [];
L.push('# The API surface, as recorded');
L.push('');
L.push('**Generated by `node describe-api.mjs`. Do not edit by hand.**');
L.push('');
L.push('Every route, field, type and status below was read out of a real response from the');
L.push('pilot control plane — one Atlas 800I A2 with eight Ascend 910B3 cards — captured');
L.push('through each persona\'s own Keycloak token.');
L.push('');
L.push('This exists so that a design team never has to ask "does the API return X". If X is');
L.push('not here, it was not captured, and if it was not captured it does not exist: the');
L.push('cluster is gone and there is no second chance to look.');
L.push('');
L.push('## How to read it');
L.push('');
L.push('- **Scope** is what the control plane requires to serve the route. A route with no');
L.push('  scope entry is refused, by design — see `internal/authz/scope.go`.');
L.push('- **Observed** is which persona got which HTTP status. A 403 is a correct answer and');
L.push('  is recorded as faithfully as a 200; a screen that cannot render one is incomplete.');
L.push('- **optional** on a field means some rows in the recording did not carry it. Those');
L.push('  are the fields that render blank for reasons nobody can reproduce later.');
L.push('');

/* Scope summary. */
L.push('## Routes at a glance');
L.push('');
L.push('| Route | Scope | Recorded | Statuses seen |');
L.push('|---|---|---|---|');
for (const r of sorted) {
  const scope = POLICY[r.route] || (r.route.startsWith('(') ? '—' : '**no policy entry**');
  const statuses = [...new Set(r.observations.map((o) => o.status))].sort().join(', ');
  const flag = r.nonJSON ? ' ⚠ not JSON' : '';
  L.push(`| \`${r.route}\` | ${scope} | ${r.observations.length} | ${statuses}${flag} |`);
}
L.push('');

/* Routes in the policy with no recording at all. */
const missing = Object.keys(POLICY).filter((p) => !routes.has(p));
if (missing.length) {
  L.push('### Routes the policy serves that were never captured');
  L.push('');
  for (const m of missing) L.push(`- \`${m}\` — ${POLICY[m]}`);
  L.push('');
  L.push('A surface built on one of these has no recording to replay and will return 501.');
  L.push('');
}

/* Per-route detail. */
L.push('## Route detail');
L.push('');
for (const r of sorted) {
  if (r.route.startsWith('(')) continue;
  L.push(`### \`${r.route}\``);
  L.push('');
  L.push(`**Scope:** ${POLICY[r.route] || '**no policy entry — this route would be refused**'}`);
  L.push('');

  const byPersona = new Map();
  for (const o of r.observations) {
    const key = `${o.persona}${o.params ? ` ?${o.params}` : ''}`;
    if (!byPersona.has(key)) byPersona.set(key, o);
  }
  L.push('| Persona / parameters | Status | Bytes |');
  L.push('|---|---|---|');
  for (const [key, o] of [...byPersona].sort()) {
    L.push(`| ${key} | ${o.status} | ${o.size} |`);
  }
  L.push('');

  if (r.shape) {
    L.push(`**Response shape**${r.shapeFrom ? ` (richest capture: ${r.shapeFrom})` : ''}:`);
    L.push('');
    if (r.shape.type === 'object' && r.shape.fields) {
      L.push(...fieldTable(r.shape.fields));
    } else {
      L.push(`- ${r.shape.type}`);
    }
    L.push('');
  } else {
    L.push('_No 200 was captured for this route, so its success shape is unknown._');
    L.push('');
  }
  if (r.nonJSON) {
    L.push('> **This route did not answer with JSON.** The body was:');
    L.push('>');
    L.push(`> \`${r.nonJSON}\``);
    L.push('');
  }
}

/* Refusal shapes — a screen has to render these. */
L.push('## What a refusal looks like');
L.push('');
L.push('A design that has never seen these will not have a place to put them.');
L.push('');
for (const f of ['refusals-fleet-me', 'refusals-fleet-nodes', 'refusals-no-credential']) {
  const file = path.join(ROOT, `${f}.json`);
  if (!existsSync(file)) continue;
  const statusFile = `${file}.status`;
  const status = existsSync(statusFile)
    ? (await readFile(statusFile, 'utf8')).trim() : '?';
  L.push(`**${f}** — HTTP ${status}`);
  L.push('');
  L.push('```json');
  L.push((await readFile(file, 'utf8')).trim());
  L.push('```');
  L.push('');
}

/* Personas. */
L.push('## The personas these were captured as');
L.push('');
L.push('| Login | Operator | Tenant admin | Tenancies | Reaches |');
L.push('|---|---|---|---|---|');
for (const p of Object.values(PERSONAS)) {
  const { reach } = await import('./server/policy.mjs');
  L.push(`| ${p.username} | ${p.operator ? 'yes' : '—'} | ${p.tenantAdmin ? 'yes' : '—'} | `
    + `${(p.tenants || []).join(', ') || '—'} | ${reach(p.tenants || []).join(', ') || '—'} |`);
}
L.push('');

console.log(L.join('\n'));
