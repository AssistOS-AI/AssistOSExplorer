#!/usr/bin/env node
// local-llm model registries E2E wrapper: runs spec 98 against the Explorer deployment of SMOKE_WORKSPACE_ROOT with fixed
// Playwright options (Chromium headless, one worker, no retries, --forbid-only), records the provenance of the run, and
// judges Playwright's JSON report into one verdict: passed, partial, qb-a32-only (the generated credential key never
// reached the agent and everything else passed) or failed. It is a live E2E profile, separate from the Box
// release-acceptance ledger of run-playwright.mjs, and it never calls requireDgxSparkEnvironment.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createPloinky } from '../lib/dgx-spark.mjs';
import {
  assertBaseUrlBindsBox, judgeRegistriesResults, locateBox, requireLocalLlmRegistriesEnvironment,
} from '../lib/local-llm-registries.mjs';

const smokeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(smokeRoot, 'node_modules', 'playwright', 'cli.js');
export const REGISTRIES_SPEC = 'specs/98-local-llm-model-registries.spec.mjs';

export const registriesHelp = `local-llm model registries E2E (spec 98)
Usage: npm run test:local-llm-registries -- [--list]

Requires SMOKE_WORKSPACE_ROOT (the deployment's workspace), SMOKE_PLOINKY_BIN (bin/ploinky of the checkout that created
it), SMOKE_BASE_URL (http://localhost:<port> or http://127.0.0.1:<port>, the port the Box publishes for 8080) and the
administrator sign-in inputs (SMOKE_LOGIN_EMAIL, SMOKE_SIGN_IN_METHOD, SMOKE_ACCOUNT_PASSWORD or its alternatives). The
Box is derived from the workspace; SMOKE_PLOINKY_BOX_CONTAINER is refused. SMOKE_ARTIFACT_DIR names the evidence
directory. --list only discovers the tests of spec 98, with no environment check, so it runs on any host.
The run changes state: it saves and removes registries, sets and clears a dummy credential, restarts local-llm, downloads
small models, runs them, and installs and removes vLLM.
Exit codes: 0 passed; 3 only A32 failed because the agent key is absent or malformed (Q-B); 1 any other failure, including
a partial snapshot group; 2 a setup error.
`;

export function parseRegistriesArgs(argv) {
  let list = false;
  for (const arg of argv) {
    if (arg === '--list') { list = true; continue; }
    throw new Error(`Unknown option ${arg}. Use --help.`);
  }
  return { list };
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function checkout(cwd) {
  return { path: cwd, commit: git(cwd, ['rev-parse', 'HEAD']), branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), clean: git(cwd, ['status', '--porcelain']) === '' };
}

// Every file of the given name below `dir`, in sorted order.
export function findFiles(dir, name) {
  const found = [];
  const walk = (current) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === name) found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const EXIT = Object.freeze({ passed: 0, 'qb-a32-only': 3 });

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') { process.stdout.write(registriesHelp); return 0; }
  const { list } = parseRegistriesArgs(argv);
  const runId = String(process.env.SMOKE_RUN_ID || `llreg-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}`).replace(/[^A-Za-z0-9_-]/g, '-');
  const artifactDir = path.resolve(process.env.SMOKE_ARTIFACT_DIR || path.join(smokeRoot, '..', '..', '.ploinky', 'test-artifacts', 'local-llm-registries', runId));
  const childEnv = { ...process.env, SMOKE_LOCAL_LLM_REGISTRIES: '1', SMOKE_RUN_ID: runId, SMOKE_ARTIFACT_DIR: artifactDir };
  for (const name of ['SMOKE_DEPLOYMENT_MODE', 'SMOKE_PREFLIGHT_ACCOUNT_REQUIREMENTS', 'PLAYWRIGHT_HTML_REPORT', 'PW_TEST_REPORTER']) delete childEnv[name];

  if (list) {
    if (!fs.existsSync(cliPath)) throw new Error(`Playwright is not installed at ${cliPath}; run npm ci first.`);
    const listed = spawnSync(process.execPath, [cliPath, 'test', '--project=chromium', '--workers=1', '--retries=0', '--forbid-only', '--list', REGISTRIES_SPEC], { cwd: smokeRoot, env: childEnv, stdio: 'inherit' });
    if (listed.error) throw listed.error;
    return listed.status ?? 1;
  }

  const env = requireLocalLlmRegistriesEnvironment();
  if (!fs.existsSync(cliPath)) throw new Error(`Playwright is not installed at ${cliPath}; run npm ci first.`);
  const ploinky = createPloinky(env);
  const box = await locateBox({ ploinky, workspaceRoot: env.workspaceRoot });
  const baseUrlComparison = assertBaseUrlBindsBox({ baseURL: env.baseURL, box });
  fs.mkdirSync(artifactDir, { recursive: true });
  const ploinkyRoot = path.resolve(path.dirname(env.ploinkyBin), '..');
  fs.writeFileSync(path.join(artifactDir, 'provenance.json'), `${JSON.stringify({
    runId, startedAt: new Date().toISOString(), spec: REGISTRIES_SPEC, workspaceRoot: env.workspaceRoot,
    ploinky: checkout(ploinkyRoot), tests: checkout(path.resolve(smokeRoot, '..', '..')),
    box: { name: box.name, id: box.id, imageId: box.imageId, startedAt: box.startedAt, imageRef: box.labels['io.assistos.ploinky-box.image-ref'] || null },
    resolvedBy: box.resolvedBy, baseURL: env.baseURL, baseUrlComparison,
  }, null, 2)}\n`, { flag: 'wx' });

  const result = spawnSync(process.execPath, [cliPath, 'test', '--project=chromium', '--workers=1', '--retries=0', '--forbid-only', REGISTRIES_SPEC], { cwd: smokeRoot, env: childEnv, stdio: 'inherit' });
  if (result.error) throw result.error;

  const reportPath = path.join(artifactDir, 'test-results', 'results.json');
  const report = fs.existsSync(reportPath) ? readJson(reportPath) : null;
  const partialFiles = findFiles(artifactDir, 'partial-snapshot.json');
  const a32Files = findFiles(artifactDir, 'a32.json');
  const a32 = a32Files.length === 1 ? readJson(a32Files[0]) : null;
  let verdict = judgeRegistriesResults(report, { exitStatus: result.status, signal: result.signal, partialFiles, a32 });
  if (a32Files.length > 1) verdict = { ...verdict, ok: false, case: 'failed', problems: [...verdict.problems, `found ${a32Files.length} a32.json files, expected at most one`] };
  fs.writeFileSync(path.join(artifactDir, 'verdict.json'), `${JSON.stringify({
    ok: verdict.ok, case: verdict.case, problems: verdict.problems, stats: verdict.stats, exit: result.status, signal: result.signal, keyProbe: verdict.keyProbe,
  }, null, 2)}\n`, { flag: 'wx' });

  if (verdict.case === 'passed') console.log(`local-llm registries E2E PASSED: ${JSON.stringify(verdict.stats)}`);
  else if (verdict.case === 'partial') console.log(`local-llm registries E2E FAILED (partial: ${verdict.problems.join('; ')})`);
  else if (verdict.case === 'qb-a32-only') console.log(`local-llm registries E2E FAILED (Q-B case: only A32 failed; agent key ${verdict.keyProbe}; every other group passed)`);
  else console.log(`local-llm registries E2E FAILED: ${verdict.problems.join('; ')}`);
  return EXIT[verdict.case] ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`[local-llm-registries] ${error.message}`);
    process.exitCode = 2;
  });
}
