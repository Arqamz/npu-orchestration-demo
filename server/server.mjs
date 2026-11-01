#!/usr/bin/env node
/* The demo control plane, as a local HTTP server.
 *
 *   node server/server.mjs                 http://127.0.0.1:8082
 *   PORT=9000 SESSION=baseline node server/server.mjs
 *
 * No dependencies, deliberately: this has to still run in a year, on a
 * laptop nobody has prepared, in front of people who will not wait for an
 * install to fail.
 *
 * It also serves the web surfaces from web/, so one command gives the whole
 * demo. In the deployed form the same core runs as a Cloudflare Pages
 * Function and the surfaces are served by Pages; the routing below and the
 * function adapter share core.mjs, so there is one implementation.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DemoAPI, Recordings, Timeline, Overlay, DemoAudit } from './core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SESSION = process.env.SESSION || 'baseline';
const PORT = parseInt(process.env.PORT || '8082', 10);
const WEB = path.join(ROOT, 'web');

const recordings = new Recordings(path.join(ROOT, 'sessions', SESSION));
const timeline = new Timeline(path.join(ROOT, 'sessions', 'autoscale'));
const hasTimeline = await timeline.load();

const api = new DemoAPI({
  recordings,
  timeline: hasTimeline ? timeline : null,
  overlay: new Overlay(),
  audit: new DemoAudit(),
});

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body)
    ? body
    : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(payload ?? ''),
    // The surfaces are served from the same origin in the deployed form,
    // but a designer running the pages off the filesystem while pointing
    // at this server is a thing that will happen.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(payload ?? '');
}

/** Serve a file from web/, with the directory-index and single-page
 *  fallbacks a static host would apply. */
async function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname.replace(/^\/+/, '')) || 'index.html';
  let file = path.join(WEB, rel);

  // Containment: a path that escapes web/ is a bug here and a disclosure
  // bug in anything that copies this.
  if (!file.startsWith(WEB)) return send(res, 403, { error: 'Forbidden' });

  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!existsSync(file)) {
    const asDir = path.join(WEB, rel, 'index.html');
    if (existsSync(asDir)) file = asDir;
    else return send(res, 404, { error: 'Not Found', path: pathname });
  }
  const body = await readFile(file);
  send(res, 200, body, TYPES[path.extname(file)] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') return send(res, 204, '');

  const isAPI = url.pathname.startsWith('/fleet')
    || url.pathname === '/healthz'
    || url.pathname.startsWith('/__demo/');

  if (!isAPI) return serveStatic(res, url.pathname);

  // Read a bounded body. The demo takes its parameters on the query
  // string, but a UI posting JSON should not hang.
  let raw = '';
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 256 * 1024) break;
    }
  }
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      // Body fields are folded into the query so core.mjs has one place to
      // read them -- and so the tenant in a body still cannot win, because
      // the scope layer rewrites it afterwards.
      for (const [k, v] of Object.entries(parsed)) {
        if (v !== null && typeof v !== 'object') url.searchParams.set(k, String(v));
      }
    } catch { /* a non-JSON body is simply ignored */ }
  }

  try {
    const { status, body } = await api.handle(
      req.method, url.pathname, url.searchParams, req.headers,
    );
    if (status === 204) {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }
    send(res, status, body);
  } catch (err) {
    send(res, 500, { error: 'Internal', reason: String(err && err.stack || err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`demo control plane  http://127.0.0.1:${PORT}`);
  console.log(`  session   ${SESSION}  (${path.join(ROOT, 'sessions', SESSION)})`);
  console.log(`  timeline  ${hasTimeline ? `${timeline.frames.length} frames` : 'NOT LOADED'}`);
  console.log(`  surfaces  ${WEB}`);
  console.log('');
  console.log('  personas: Authorization: Bearer demo-fleet-operator | demo-maas-co-admin | ...');
  console.log('  GET /__demo/personas for the full list');
});
