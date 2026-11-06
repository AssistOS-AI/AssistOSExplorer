#!/usr/bin/env node
// Robot coding-agent E2E wrapper: runs specs/11-robot-coding-agents.spec.mjs against one deployment with fixed Playwright
// options (Chromium headless, one worker, no retries) and judges the report. Every discovered test must pass or be
// skipped with its reason (a turn without its credential); a failure, a flaky retry, an interruption or zero passing
// tests fail the run. The skipped tests and their reasons are printed so a skip is never read as a pass.
// It is a local/QA diagnostic profile, separate from the Box release-acceptance ledger of run-playwright.mjs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const smokeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(smokeRoot, 'node_modules', 'playwright', 'cli.js');
export const ROBOT_AGENT_SPEC = 'specs/11-robot-coding-agents.spec.mjs';

export const robotAgentsHelp = `Robot coding-agent E2E
Usage: npm run test:robot-coding-agents -- [--list]

Requires SMOKE_BASE_URL (use http://localhost:8080 locally) and an administrator sign-in (SMOKE_LOGIN_EMAIL,
SMOKE_SIGN_IN_METHOD, SMOKE_ACCOUNT_PASSWORD or its alternatives). It creates one run-owned robot with Codex, OpenCode,
Pi and Claude Code, opens one terminal, and deletes both afterwards. Optional turns read SMOKE_ROBOT_CODEX_API_KEY and
SMOKE_ROBOT_CLAUDE_API_KEY; without them those turns are skipped and reported. No model runs locally.
`;

// Pure: every discovered test must have passed or been skipped, and at least one must have passed.
export function judgeResults(report) {
  const stats = report?.stats || {};
  const problems = [];
  if (!Number.isInteger(stats.expected) || stats.expected < 1) problems.push('no test passed');
  for (const key of ['unexpected', 'flaky']) if (stats[key]) problems.push(`${stats[key]} ${key}`);
  if (stats.interrupted) problems.push(`${stats.interrupted} interrupted`);
  return { ok: problems.length === 0, problems, stats };
}

export function collectSkips(report) {
  const skips = [];
  const walk = (suite, titles) => {
    const here = suite.title && suite.title !== suite.file ? [...titles, suite.title] : titles;
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        if (test.status === 'skipped') {
          const reason = test.annotations?.find((annotation) => annotation.type === 'skip')?.description;
          // A serial run skips every test after a failure without an annotation: those tests did not run.
          skips.push({ title: [...here, spec.title].join(' > '), reason: reason || 'did not run (an earlier test of the serial run failed)', ran: false, skipped: Boolean(reason) });
        }
      }
    }
    for (const child of suite.suites || []) walk(child, here);
  };
  for (const suite of report?.suites || []) walk(suite, []);
  return skips;
}

// Pure: the facts of the evidence file a reader needs next to the verdict, so that a pass on a fallback route or a
// skipped turn is never read as a pass of the primary route.
export function summarizeEvidence(evidence) {
  const turn = evidence?.agents?.opencode?.turn;
  const opencode = turn && typeof turn === 'object'
    ? { soulOutcome: turn.soul?.outcome ?? null, hostedFallback: Boolean(turn.hosted), answeredBy: turn.answeredBy ?? null }
    : { soulOutcome: null, hostedFallback: false, answeredBy: null, note: typeof turn === 'string' ? turn : 'no OpenCode turn recorded' };
  const codex = evidence?.agents?.codex?.probes || {};
  return {
    opencode,
    codex: { daemonRunning: codex.daemonRunning ?? null, negativeControl: codex.negativeControl ?? null },
    turns: Object.fromEntries(Object.entries(evidence?.agents || {}).map(([name, agent]) => [name,
      typeof agent.turn === 'string' ? agent.turn.split(':')[0] : agent.turn?.answeredBy ? 'answered' : 'not answered'])),
  };
}

function main(argv) {
  if (argv.includes('--help')) { process.stdout.write(robotAgentsHelp); return 0; }
  const list = argv.includes('--list');
  if (argv.some((arg) => arg !== '--list')) throw new Error(`Unknown option. Use --help.`);
  if (!process.env.SMOKE_BASE_URL) throw new Error('SMOKE_BASE_URL is required (http://localhost:8080 for a local deployment).');
  if (!fs.existsSync(cliPath)) throw new Error(`Playwright is not installed at ${cliPath}; run npm ci first.`);
  const runId = String(process.env.SMOKE_RUN_ID || `rca-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}`).replace(/[^A-Za-z0-9_-]/g, '-');
  const artifactDir = path.resolve(process.env.SMOKE_ARTIFACT_DIR || path.join(smokeRoot, '..', '..', '.ploinky', 'test-artifacts', 'robot-coding-agents', runId));
  fs.mkdirSync(artifactDir, { recursive: true });
  const childEnv = { ...process.env, SMOKE_ROBOT_CODING_AGENTS: '1', SMOKE_RUN_ID: runId, SMOKE_ARTIFACT_DIR: artifactDir };
  for (const name of ['SMOKE_DEPLOYMENT_MODE', 'SMOKE_PREFLIGHT_ACCOUNT_REQUIREMENTS', 'PLAYWRIGHT_HTML_REPORT', 'PW_TEST_REPORTER']) delete childEnv[name];
  const args = [cliPath, 'test', '--project=chromium', '--workers=1', '--retries=0', '--forbid-only', ...(list ? ['--list'] : []), ROBOT_AGENT_SPEC];
  const result = spawnSync(process.execPath, args, { cwd: smokeRoot, env: childEnv, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (list) return result.status ?? 1;
  const reportPath = path.join(artifactDir, 'test-results', 'results.json');
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
  const verdict = judgeResults(report);
  const skips = collectSkips(report);
  const evidencePath = path.join(artifactDir, 'robot-coding-agents-evidence.json');
  const summary = fs.existsSync(evidencePath) ? summarizeEvidence(JSON.parse(fs.readFileSync(evidencePath, 'utf8'))) : null;
  fs.writeFileSync(path.join(artifactDir, 'verdict.json'), `${JSON.stringify({ exit: result.status, ...verdict, ok: verdict.ok && result.status === 0, skips, evidence: summary }, null, 2)}\n`);
  for (const skip of skips) console.log(`${skip.skipped ? 'SKIPPED' : 'DID NOT RUN'}: ${skip.title} -- ${skip.reason}`);
  if (summary) {
    console.log(`OpenCode turn: Soul Gateway route ${summary.opencode.soulOutcome ?? 'not run'}; answered by ${summary.opencode.answeredBy ?? 'nobody'}${summary.opencode.hostedFallback ? ' (hosted-model fallback after a Soul rate limit)' : ''}`);
    console.log(`Codex client: background app-server running=${summary.codex.daemonRunning}; ps-hidden negative control=${summary.codex.negativeControl}`);
  }
  console.log(`Robot coding-agent E2E ${verdict.ok && result.status === 0 ? 'PASSED' : 'FAILED'}: ${JSON.stringify(verdict.stats)}${verdict.problems.length ? ` (${verdict.problems.join(', ')})` : ''}; artifacts ${artifactDir}`);
  return verdict.ok && result.status === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) {
    console.error(`[robot-coding-agents] ${error.message}`);
    process.exitCode = 2;
  }
}
