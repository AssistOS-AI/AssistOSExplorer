#!/usr/bin/env node
// DGX Spark E2E wrapper: runs specs 93-96 against the Explorer deployment of SMOKE_WORKSPACE_ROOT with fixed Playwright
// options (Chromium headless, one worker, no retries), records the provenance of the run, and passes only when every
// discovered test passed: a skip, a flaky retry, an interruption or zero discovered tests all fail the run.
// It is a hardware E2E profile, separate from the Box release-acceptance ledger of run-playwright.mjs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { requireDgxSparkEnvironment, resolveBox, createPloinky, runCommand } from '../lib/dgx-spark.mjs';

const smokeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(smokeRoot, 'node_modules', 'playwright', 'cli.js');
export const DGX_SPECS = Object.freeze([
  'specs/93-dgx-spark-platform.spec.mjs',
  'specs/94-dgx-spark-local-llm.spec.mjs',
  'specs/95-dgx-spark-hardware-limits.spec.mjs',
  'specs/96-dgx-spark-gpu-grant.spec.mjs',
]);

export const dgxHelp = `DGX Spark E2E suite
Usage: npm run test:dgx-spark -- [--spec 93|94|95|96]... [--list]

Requires SMOKE_WORKSPACE_ROOT (the deployment's workspace), SMOKE_PLOINKY_BIN (bin/ploinky of the checkout that
created it), SMOKE_BASE_URL and the administrator sign-in inputs (SMOKE_LOGIN_EMAIL, SMOKE_SIGN_IN_METHOD,
SMOKE_ACCOUNT_PASSWORD or its alternatives). The Box is derived from the workspace; SMOKE_PLOINKY_BOX_CONTAINER is
refused. Spec 95 turns the hardware-limits gate on (PLOINKY_BOX_HARDWARE_LIMITS=on ploinky restart) when it is off,
and spec 96 revokes and grants local-llm's GPU; both restart the workspace graph.
`;

export function parseDgxArgs(argv) {
  const selected = [];
  let list = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--list') { list = true; continue; }
    if (arg === '--spec') {
      const value = argv[index + 1];
      const spec = DGX_SPECS.find((candidate) => candidate.startsWith(`specs/${value}-`));
      if (!spec) throw new Error(`--spec must be one of ${DGX_SPECS.map((candidate) => candidate.slice(6, 8)).join(', ')}.`);
      if (!selected.includes(spec)) selected.push(spec);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option ${arg}. Use --help.`);
  }
  return { specs: selected.length ? DGX_SPECS.filter((spec) => selected.includes(spec)) : [...DGX_SPECS], list };
}

// Every discovered test must have passed exactly once.
export function judgeResults(report) {
  const stats = report?.stats || {};
  const problems = [];
  if (!Number.isInteger(stats.expected) || stats.expected < 1) problems.push('no test passed');
  for (const key of ['unexpected', 'flaky', 'skipped']) if (stats[key]) problems.push(`${stats[key]} ${key}`);
  if (stats.interrupted) problems.push(`${stats.interrupted} interrupted`);
  return { ok: problems.length === 0, problems, stats };
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function checkout(cwd) {
  return { path: cwd, commit: git(cwd, ['rev-parse', 'HEAD']), branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), clean: git(cwd, ['status', '--porcelain']) === '' };
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') { process.stdout.write(dgxHelp); return 0; }
  const { specs, list } = parseDgxArgs(argv);
  const env = requireDgxSparkEnvironment();
  if (!fs.existsSync(cliPath)) throw new Error(`Playwright is not installed at ${cliPath}; run npm ci first.`);
  const runId = String(process.env.SMOKE_RUN_ID || `dgx-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}`).replace(/[^A-Za-z0-9_-]/g, '-');
  const artifactDir = path.resolve(process.env.SMOKE_ARTIFACT_DIR || path.join(smokeRoot, '..', '..', '.ploinky', 'test-artifacts', 'dgx-spark', runId));
  fs.mkdirSync(artifactDir, { recursive: true });
  const childEnv = { ...process.env, SMOKE_DGX_SPARK: '1', SMOKE_RUN_ID: runId, SMOKE_ARTIFACT_DIR: artifactDir };
  for (const name of ['SMOKE_DEPLOYMENT_MODE', 'SMOKE_PREFLIGHT_ACCOUNT_REQUIREMENTS', 'PLAYWRIGHT_HTML_REPORT', 'PW_TEST_REPORTER']) delete childEnv[name];

  if (!list) {
    const box = await resolveBox({ ploinky: createPloinky(env), run: runCommand });
    const ploinkyRoot = path.resolve(path.dirname(env.ploinkyBin), '..');
    fs.writeFileSync(path.join(artifactDir, 'provenance.json'), `${JSON.stringify({
      runId, startedAt: new Date().toISOString(), specs, workspaceRoot: env.workspaceRoot,
      ploinky: checkout(ploinkyRoot), tests: checkout(path.resolve(smokeRoot, '..', '..')),
      box: { name: box.name, id: box.id, imageId: box.imageId, imageRef: box.labels['io.assistos.ploinky-box.image-ref'] || null, startedAt: box.startedAt, gpuWiring: box.gpu.wiringFingerprint },
    }, null, 2)}\n`, { flag: 'wx' });
  }
  const args = [cliPath, 'test', '--project=chromium', '--workers=1', '--retries=0', ...(list ? ['--list'] : []), ...specs];
  const result = spawnSync(process.execPath, args, { cwd: smokeRoot, env: childEnv, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (list) return result.status ?? 1;
  const reportPath = path.join(artifactDir, 'test-results', 'results.json');
  const verdict = judgeResults(fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null);
  fs.writeFileSync(path.join(artifactDir, 'verdict.json'), `${JSON.stringify({ exit: result.status, ...verdict }, null, 2)}\n`);
  console.log(`DGX Spark E2E ${verdict.ok && result.status === 0 ? 'PASSED' : 'FAILED'}: ${JSON.stringify(verdict.stats)}${verdict.problems.length ? ` (${verdict.problems.join(', ')})` : ''}; artifacts ${artifactDir}`);
  return verdict.ok && result.status === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`[dgx-spark] ${error.message}`);
    process.exitCode = 2;
  });
}
