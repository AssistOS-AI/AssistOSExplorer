#!/usr/bin/env node
// Runs the RoboWork worker e2e specs against a deployed Explorer whose RoboTeam runs on the robo-work worker.
// The administrator sign-in values come from a mode 0600 JSON file ({"primary":{"loginEmail","accountPassword"}}) and
// are passed to Playwright only through its environment; nothing is printed.
//   node scripts/run-robowork-e2e.mjs [playwright test arguments or spec files]    (default: specs/08-robowork-worker.spec.mjs)
//
//   SMOKE_ROBOWORK_ACCOUNTS  accounts file (default ~/.local/state/ploinky-tests/robowork-r10-e2e/accounts.json)
//   SMOKE_WORKSPACE_ROOT     host path of the deployed workspace (default ~/work/testExplorerFresh)
//   GATE=1                   gate run: SMOKE_EXPECT_EXPLORER_COMMIT is required and asserted against the deployed AchillesIDE HEAD
//   SMOKE_ARTIFACT_DIR       base directory for the runs (default <repo>/.ploinky/test-artifacts/robowork/<stamp>); every pass uses a NEW
//                            sub-directory, because the acceptance reporter writes its ledger with the `wx` flag
//   SMOKE_ROBOWORK_EVIDENCE  evidence base (default <artifact base>/evidence); each pass writes to <evidence base>/pass-N
//   SMOKE_ROBOWORK_PREFLIGHT 1 (default for GATE=1) runs the provider-liveness preflight first; 0 disables it. The preflight may move the e2e robots to
//                            another free OpenCode model that needs no new credentials; the result is passed on as SMOKE_ROBOWORK_MODEL. When no model
//                            answers the runner stops with exit code 3 ("provider not live").
//   SMOKE_ROBOWORK_RERUNS    how often a scenario marked rerun-needed (a provider stall) is run again, default 2. A scenario that is still
//                            rerun-needed afterwards fails the run: a stall is never counted as a pass.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const smokeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(smokeRoot, '../..');
const accountsPath = process.env.SMOKE_ROBOWORK_ACCOUNTS
  || path.join(os.homedir(), '.local/state/ploinky-tests/robowork-r10-e2e/accounts.json');
const stat = fs.statSync(accountsPath);
if ((stat.mode & 0o077) !== 0) throw new Error('The accounts file must not be accessible to group or others (mode 0600).');
const { primary } = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
// Gate runs (GATE=1) must name the candidate: the specs then assert the deployed AchillesIDE HEAD against SMOKE_EXPECT_EXPLORER_COMMIT.
if (process.env.GATE === '1' && !/^[0-9a-f]{7,40}$/i.test(process.env.SMOKE_EXPECT_EXPLORER_COMMIT || '')) {
  throw new Error('GATE=1 requires SMOKE_EXPECT_EXPLORER_COMMIT (a 7 to 40 digit hexadecimal commit).');
}
const specArgsRaw = process.argv.slice(2);
const baseEnv = {
  ...process.env,
  SMOKE_ROBOWORK: '1',
  // Running the preflight spec by itself is an explicit request for it.
  ...(specArgsRaw.some((entry) => /07-robowork-preflight/.test(entry)) ? { SMOKE_ROBOWORK_PREFLIGHT: '1' } : {}),
  SMOKE_BASE_URL: process.env.SMOKE_BASE_URL || 'http://localhost:8080',
  SMOKE_WORKSPACE_ROOT: process.env.SMOKE_WORKSPACE_ROOT || path.join(os.homedir(), 'work/testExplorerFresh'),
  SMOKE_LOGIN_EMAIL: primary.loginEmail,
  SMOKE_USERNAME: primary.username || primary.loginEmail,
  SMOKE_SIGN_IN_METHOD: 'password',
  SMOKE_ACCOUNT_PASSWORD: primary.accountPassword,
  PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE || 'ubuntu24.04-x64',
};
const stamp = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}`;
const artifactBase = path.resolve(process.env.SMOKE_ARTIFACT_DIR || path.join(repoRoot, '.ploinky/test-artifacts/robowork', stamp));
const evidenceBase = path.resolve(process.env.SMOKE_ROBOWORK_EVIDENCE || path.join(artifactBase, 'evidence'));
const args = process.argv.slice(2);
const specArgs = args.length ? args : ['specs/08-robowork-worker.spec.mjs'];
const preflightOnly = specArgs.some((entry) => /07-robowork-preflight/.test(entry));
const preflightWanted = !preflightOnly && (process.env.SMOKE_ROBOWORK_PREFLIGHT ? process.env.SMOKE_ROBOWORK_PREFLIGHT === '1' : process.env.GATE === '1');
const maxReruns = Number.parseInt(process.env.SMOKE_ROBOWORK_RERUNS ?? '2', 10);

function playwright(extra, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(smokeRoot, 'node_modules/playwright/cli.js'), 'test', '--project=chromium', '--workers=1', '--retries=0', ...extra],
      { cwd: smokeRoot, env, stdio: 'inherit' });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

// One Playwright pass in a fresh artifact and evidence directory. Returns the exit code and the specs of its JSON report.
async function pass(name, extra, extraEnv = {}) {
  const artifactDir = path.join(artifactBase, name);
  const evidenceDir = path.join(evidenceBase, name);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const code = await playwright(extra, { ...baseEnv, ...extraEnv, SMOKE_ARTIFACT_DIR: artifactDir, SMOKE_ROBOWORK_EVIDENCE: evidenceDir });
  const specs = [];
  try {
    const report = JSON.parse(fs.readFileSync(path.join(artifactDir, 'test-results', 'results.json'), 'utf8'));
    const walk = (suite) => {
      for (const spec of suite.specs ?? []) {
        const test = spec.tests?.[0];
        const result = test?.results?.at(-1);
        const message = String(result?.error?.message ?? result?.errors?.[0]?.message ?? '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((line) => line.trim()) ?? '';
        specs.push({ title: spec.title, file: spec.file, ok: spec.ok === true, skipped: test?.status === 'skipped', error: message.slice(0, 300),
          rerunNeeded: (test?.annotations ?? []).some((annotation) => annotation.type === 'rerun-needed'),
          rerunEvidence: (test?.annotations ?? []).filter((annotation) => annotation.type === 'rerun-needed').map((annotation) => annotation.description).join('; ').slice(0, 300) });
      }
      for (const child of suite.suites ?? []) walk(child);
    };
    for (const suite of report.suites ?? []) walk(suite);
  } catch { /* no report: the exit code decides */ }
  return { code, specs, evidenceDir };
}

async function preflight(label) {
  const out = path.join(artifactBase, `${label}-selected-model.json`);
  fs.mkdirSync(artifactBase, { recursive: true });
  fs.rmSync(out, { force: true });
  const result = await pass(label, ['specs/07-robowork-preflight.spec.mjs'], { SMOKE_ROBOWORK_PREFLIGHT: '1', SMOKE_ROBOWORK_PREFLIGHT_OUT: out });
  let selected = null;
  try { selected = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* none */ }
  return { ok: result.code === 0 && selected?.ok === true, selected };
}

const finalStatus = new Map();
// Keeps the first failure reason of a scenario next to its final verdict, also when a rerun later passed.
const record = (specs, passName) => {
  for (const spec of specs) {
    if (spec.skipped && finalStatus.has(spec.title)) continue;
    const previous = finalStatus.get(spec.title);
    const firstFailure = previous?.firstFailure ?? (!spec.ok && !spec.skipped ? { pass: passName, reason: spec.error, rerunNeeded: spec.rerunNeeded, evidence: spec.rerunEvidence } : undefined);
    finalStatus.set(spec.title, { ...spec, firstFailure });
  }
};

let modelEnv = {};
if (preflightWanted) {
  const first = await preflight('preflight-1');
  if (!first.ok) {
    console.error('\n[robowork] PROVIDER NOT LIVE: no model answered the tiny turn. Nothing was run; this is not a pass. See', evidenceBase);
    process.exit(3);
  }
  modelEnv = { SMOKE_ROBOWORK_MODEL: first.selected.selectedModel || '' };
  console.error(`[robowork] preflight ok; model: ${first.selected.selectedModel || '(deployment default)'}`);
}

let current = await pass('pass-1', specArgs, modelEnv);
record(current.specs, 'pass-1');
let exitCode = current.code;
for (let rerun = 1; rerun <= maxReruns; rerun += 1) {
  const pending = current.specs.filter((spec) => !spec.ok && !spec.skipped && spec.rerunNeeded);
  if (!pending.length) break;
  console.error(`\n[robowork] rerun-needed (provider stall) for: ${pending.map((spec) => spec.title).join(' | ')}; rerun ${rerun} of ${maxReruns}`);
  if (preflightWanted) {
    const again = await preflight(`preflight-${rerun + 1}`);
    if (!again.ok) { console.error('[robowork] PROVIDER NOT LIVE before the rerun; stopping. The scenarios above stay rerun-needed (not passed).'); exitCode = 3; break; }
    modelEnv = { SMOKE_ROBOWORK_MODEL: again.selected.selectedModel || '' };
  }
  const grep = pending.map((spec) => spec.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  current = await pass(`pass-${rerun + 1}`, [...specArgs, '--grep', grep], modelEnv);
  record(current.specs, `pass-${rerun + 1}`);
}

// The verdict: every scenario's last result. A scenario still marked rerun-needed is not a pass.
let failed = 0;
console.error('\n[robowork] final results');
for (const spec of finalStatus.values()) {
  const verdict = spec.skipped ? 'skipped' : spec.ok ? 'passed' : spec.rerunNeeded ? 'RERUN-NEEDED (provider stall, not a pass)' : 'FAILED';
  if (!spec.skipped && !spec.ok) failed += 1;
  console.error(`  ${verdict.padEnd(12)} ${spec.title}`);
  if (spec.firstFailure) console.error(`               ${spec.firstFailure.pass} failure: ${spec.firstFailure.reason}${spec.firstFailure.evidence ? ` [rerun-needed evidence: ${spec.firstFailure.evidence}]` : ''}`);
}
if (exitCode === 3) process.exit(3);
const passed = [...finalStatus.values()].filter((spec) => spec.ok && !spec.skipped).length;
if (process.env.GATE === '1' && passed === 0) { console.error('[robowork] GATE=1 and nothing passed: all scenarios were skipped or missing.'); process.exit(1); }
process.exit(failed > 0 ? 1 : (finalStatus.size === 0 ? current.code : 0));
