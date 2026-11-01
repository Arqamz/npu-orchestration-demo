#!/usr/bin/env node
/* Assemble the deployable directory.
 *
 * Pages serves static files and runs functions/; it cannot list a
 * directory, so anything the Function needs to enumerate has to be written
 * down at build time. That is the only thing this does beyond copying.
 *
 *   node build.mjs            -> dist/
 */

import { cp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

/* The surfaces. */
await cp(path.join(HERE, 'web'), DIST, { recursive: true });

/* The recordings the demo actually serves.
 *
 * sessions/ also holds `drift` and `healthy`, captured a week earlier
 * against the previous persona set and before /fleet/endpoints and
 * /fleet/logs existed. They are kept in the repository as reference -- a
 * fleet with real drift on it is worth having -- and deliberately NOT
 * shipped: nothing routes to them, and a session that 501s on half the
 * routes a surface asks for would read as a broken demo rather than as an
 * older recording. */
for (const s of ['baseline', 'autoscale']) {
  await cp(path.join(HERE, 'sessions', s), path.join(DIST, 'sessions', s), { recursive: true });
}

/* The frame manifest: offsets in order, with the pod file beside each.
 * Without this the Function has no way to know which frames exist. */
const framesDir = path.join(HERE, 'sessions', 'autoscale', 'frames');
if (existsSync(framesDir)) {
  const files = (await readdir(framesDir)).filter((f) => /^\d+\.json$/.test(f)).sort();
  const index = [];
  for (const f of files) {
    const base = f.replace(/\.json$/, '');
    const offFile = path.join(framesDir, `${base}.offset`);
    const offset = existsSync(offFile)
      ? parseInt((await readFile(offFile, 'utf8')).trim(), 10)
      : index.length * 5;
    const podsFile = `${base}.pods.json`;
    index.push({
      file: f,
      offset,
      pods: existsSync(path.join(framesDir, podsFile)) ? podsFile : null,
    });
  }
  await writeFile(
    path.join(DIST, 'sessions', 'autoscale', 'frames', 'index.json'),
    JSON.stringify(index, null, 2),
  );

  /* A single bundle of every frame.
   *
   * The first deployed version fetched the frames one at a time and died
   * with "Too many subrequests by single Worker invocation": 80 frames is
   * 160 fetches and a Worker gets 50. One file is one subrequest.
   *
   * The endpoint bodies go in whole -- they are the API contract and the
   * serving page renders them field for field. The pod objects do not:
   * they are 4MB of full Kubernetes PodSpec, of which the replica cards
   * use seven fields. The trimmed form is what ships in the bundle; the
   * complete objects stay beside it as individual files for anyone who
   * needs them.
   */
  const bundle = [];
  for (const entry of index) {
    const body = JSON.parse(await readFile(path.join(framesDir, entry.file), 'utf8'));
    let pods = null;
    if (entry.pods) {
      const full = JSON.parse(await readFile(path.join(framesDir, entry.pods), 'utf8'));
      pods = {
        items: (full.items || []).map((p) => ({
          metadata: {
            name: p.metadata?.name,
            annotations: {
              'huawei.com/AscendReal': p.metadata?.annotations?.['huawei.com/AscendReal'],
              'hccl/rankIndex': p.metadata?.annotations?.['hccl/rankIndex'],
            },
          },
          spec: { nodeName: p.spec?.nodeName },
          status: {
            phase: p.status?.phase,
            conditions: (p.status?.conditions || [])
              .filter((c) => c.type === 'Ready' || c.type === 'PodScheduled')
              .map((c) => ({ type: c.type, status: c.status, reason: c.reason, message: c.message })),
            containerStatuses: (p.status?.containerStatuses || [])
              .map((c) => ({
                name: c.name,
                restartCount: c.restartCount,
                state: c.state?.waiting ? { waiting: { reason: c.state.waiting.reason } } : {},
              })),
          },
        })),
      };
    }
    bundle.push({ offset: entry.offset, body, pods });
  }
  await writeFile(
    path.join(DIST, 'sessions', 'autoscale', 'frames.bundle.json'),
    JSON.stringify(bundle),
  );
  const kb = (JSON.stringify(bundle).length / 1024).toFixed(0);
  console.log(`frame manifest: ${index.length} frames; bundle ${kb} KB`);
}

/* The functions directory sits beside the assets, and imports from
 * ../server, so that has to ship too. */
await cp(path.join(HERE, 'functions'), path.join(DIST, 'functions'), { recursive: true });
await cp(path.join(HERE, 'server'), path.join(DIST, 'server'), { recursive: true });

/* Pages would otherwise serve server/ and functions/ as downloadable
 * files. Excluded from the asset manifest rather than deleted, because the
 * Function needs them at module-resolution time. */
await writeFile(path.join(DIST, '_routes.json'), JSON.stringify({
  version: 1,
  include: ['/fleet/*', '/fleet', '/healthz', '/__demo/*'],
  exclude: [],
}, null, 2));

/* Long-lived caching for the recordings, none for the pages: a demo that
 * serves a stale page after a redeploy is a demo that shows the wrong
 * thing in front of an audience. */
await writeFile(path.join(DIST, '_headers'), [
  '/sessions/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
  '/*.html',
  '  Cache-Control: no-cache',
  '',
  '/',
  '  Cache-Control: no-cache',
  '',
].join('\n'));

console.log(`built ${DIST}`);
