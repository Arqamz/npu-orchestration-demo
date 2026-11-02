#!/usr/bin/env node
/* Deploy dist/ to every Pages project.
 *
 * WHY THIS IS A SCRIPT AND NOT A SHELL LOOP.
 *
 * Every project is handed the SAME dist/ -- the whole app, so the nav
 * works from any subdomain -- with one file that differs: `_redirects`.
 * Without it, every subdomain serves the pitch page at `/`, so
 * npu-console.pages.dev shows the overview and the console is only at
 * /console/. The subdomain names then promise something the links do not
 * deliver, and a link shared into a chat lands on the wrong page.
 *
 * That is exactly what had happened: there was no _redirects anywhere and
 * all seven roots served the pitch page.
 *
 * A *.pages.dev subdomain IS a project -- there is no way to put
 * serving.npu-orchestration.pages.dev under one project -- so one deploy
 * per surface is the shape, and the per-project file has to be written
 * between deploys. Doing that in a shell loop means the redirect and the
 * project name can drift apart; here they are one table.
 */

import { writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');

/** project -> the path its root should land on. null means serve the
 *  pitch page, which is what the root project is for. */
const PROJECTS = [
  ['npu-orchestration', null],
  ['npu-console', '/console/'],
  ['npu-serving', '/serving/'],
  ['npu-workspace', '/workspace/'],
  ['npu-tenant', '/tenant/'],
  ['npu-finance', '/finance/'],
  ['npu-support', '/support/'],
];

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!ACCOUNT || !TOKEN) {
  console.error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set.');
  process.exit(1);
}

const only = process.argv[2];
let failed = 0;

for (const [project, surface] of PROJECTS) {
  if (only && only !== project) continue;

  const redirects = path.join(DIST, '_redirects');
  if (surface) {
    // 302 and not 301: a permanent redirect is cached by the browser
    // forever, so moving a surface later would strand everyone who had
    // visited once. These are demo subdomains; they will move.
    await writeFile(redirects, `/  ${surface}  302\n`);
  } else {
    await rm(redirects, { force: true });
  }

  process.stdout.write(`${project.padEnd(20)} `);
  try {
    const out = execFileSync('npx', [
      '--yes', 'wrangler@latest', 'pages', 'deploy', DIST,
      `--project-name=${project}`, '--branch=main', '--commit-dirty=true',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const url = (out.match(/https:\/\/\S+\.pages\.dev/g) || []).pop() || '(no url)';
    console.log(`-> https://${project}.pages.dev${surface || '/'}   (${url})`);
  } catch (err) {
    console.log(`FAILED\n${String(err.stderr || err.message).slice(0, 400)}`);
    failed += 1;
  }
}

// Leave the tree as the build left it, so a later `wrangler pages deploy
// dist` by hand does not silently carry the last project's redirect.
await rm(path.join(DIST, '_redirects'), { force: true });

process.exit(failed === 0 ? 0 : 1);
