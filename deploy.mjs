#!/usr/bin/env node
/* Deploy dist/ to the Pages project.
 *
 * ONE PROJECT, NOT SEVEN.
 *
 * There used to be a project per surface -- npu-console, npu-serving and
 * so on -- each carrying an identical copy of the whole app with a
 * different redirect on its root. That was silly: the same seven pages
 * deployed seven times, seven build artefacts to keep in step, and seven
 * links to correct whenever one moved. The nav already carries every
 * surface, so npu-orchestration.pages.dev/finance/ is the whole answer.
 *
 * The six duplicates were deleted on 2026-11-02. Keeping the script as a
 * table of one makes adding a genuinely separate deployment -- a
 * customer-branded instance, say -- an edit rather than a rewrite.
 */

import { writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');

/** project -> the path its root should land on. null means serve the
 *  overview, which is what the root is for. */
const PROJECTS = [
  ['npu-orchestration', null],
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
