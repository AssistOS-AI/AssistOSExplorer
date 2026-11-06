import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.SMOKE_ARTIFACT_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'robot-terminal-'));

const { NATIVE_FAILURE, classifySoulAttempt, deleteRobot, hasTokenLine, stripAnsi } = await import('./robot-terminal.mjs');
const { collectSkips, judgeResults, summarizeEvidence } = await import('../scripts/run-robot-coding-agents.mjs');

const compact = (text) => stripAnsi(text).replace(/\s+/gu, '');

test('stripAnsi removes escapes and normalises line ends', () => {
  assert.equal(stripAnsi('\u001b[1;32mok\u001b[0m\r\nnext\u001b]0;title\u0007'), 'ok\nnext');
});

// Captured from the Codex interactive client in a robot terminal on the roboteam-agent image created 2026-10-15
// (no ps): the failure the detector must flag.
const CODEX_WITHOUT_PS = 'Ask Codex to do anything    ? for shortcuts ~Error: failed to record pid-managed app-server process 70 startup: '
  + 'failed to invoke ps for pid-managed app server: No such file or directory (os error 2)\r\nTo work without the background server, '
  + 'rerun the same command with --no-daemon';

test('the failure detector flags the Codex missing-ps error and nothing in a healthy start', () => {
  assert.match(compact(CODEX_WITHOUT_PS), NATIVE_FAILURE);
  assert.doesNotMatch(compact('>_ OpenAI Codex (v0.167.0)   loading   \u001b[2m› Ask Codex to do anything    ? for shortcuts'), NATIVE_FAILURE);
  assert.doesNotMatch(compact('Welcome to Claude Code v2.1.318 ....'), NATIVE_FAILURE);
  assert.match(compact('bash: ps: command not found'), NATIVE_FAILURE);
});

test('judgeResults passes skips but not failures, flakes, interruptions or an empty run', () => {
  assert.equal(judgeResults({ stats: { expected: 9, skipped: 3, unexpected: 0, flaky: 0 } }).ok, true);
  assert.equal(judgeResults({ stats: { expected: 9, unexpected: 1, flaky: 0 } }).ok, false);
  assert.equal(judgeResults({ stats: { expected: 9, unexpected: 0, flaky: 1 } }).ok, false);
  assert.equal(judgeResults({ stats: { expected: 0, skipped: 12 } }).ok, false);
  assert.equal(judgeResults({ stats: { expected: 2, interrupted: 1 } }).ok, false);
  assert.equal(judgeResults(null).ok, false);
});

test('collectSkips reports each skipped test with its reason', () => {
  const report = { suites: [{ title: 'x.spec.mjs', file: 'x.spec.mjs', suites: [{ title: 'Robot', file: 'x.spec.mjs', suites: [{ title: 'Codex', file: 'x.spec.mjs', specs: [
    { title: 'answers one real turn', tests: [{ status: 'skipped', annotations: [{ type: 'skip', description: 'no key' }] }] },
    { title: 'starts', tests: [{ status: 'expected', annotations: [] }] },
  ] }] }] }] };
  assert.deepEqual(collectSkips(report), [{ title: 'Robot > Codex > answers one real turn', reason: 'no key', ran: false, skipped: true }]);
  const unannotated = { suites: [{ title: 'x.spec.mjs', file: 'x.spec.mjs', specs: [{ title: 'later test', tests: [{ status: 'skipped', annotations: [] }] }] }] };
  const [entry] = collectSkips(unannotated);
  assert.equal(entry.skipped, false);
  assert.match(entry.reason, /did not run/);
});

test('hasTokenLine requires the whole reply line', () => {
  assert.equal(hasTokenLine('\u001b[0m\n> build\nRCA_OK\n', 'RCA_OK'), true);
  assert.equal(hasTokenLine('echo "RCA_OK please"\n', 'RCA_OK'), false);
  assert.equal(hasTokenLine('RCA_OK_EXTRA\n', 'RCA_OK'), false);
});

test('a Soul attempt may fall back only on a recognised rate-limit or quota refusal', () => {
  const t = 'RCA_OK';
  assert.equal(classifySoulAttempt('> build\nRCA_OK\n', t), 'answered');
  assert.equal(classifySoulAttempt('Error: Soul Gateway request failed (HTTP 429).', t), 'rate-limited');
  assert.equal(classifySoulAttempt('Error: Soul Gateway request failed (HTTP 402).', t), 'rate-limited');
  assert.equal(classifySoulAttempt('provider quota exceeded', t), 'rate-limited');
  for (const broken of ['', 'Error: Soul Gateway request failed (HTTP 500).', 'Error: Soul Gateway request failed (HTTP 401).',
    'connect ENOENT /workspace/roboteam-soul/gateway.sock', 'Error: Soul Gateway request failed (HTTP 404).', 'Error: model not found']) {
    assert.equal(classifySoulAttempt(broken, t), 'broken', broken);
  }
});

test('deleteRobot retries a stopping robot a bounded number of times', async () => {
  const statuses = [409, 409, 200];
  const calls = [];
  const page = {
    request: { get: async () => ({ status: () => 200, json: async () => ({ browserMutation: { origin: 'http://x', csrfToken: 'c' } }) }),
      fetch: async () => { calls.push(1); const status = statuses.shift() ?? 409; return { status: () => status, text: async () => JSON.stringify({ ok: status === 200 }) }; } },
    waitForTimeout: async () => {},
  };
  assert.deepEqual(await deleteRobot(page, 'robot-1', { attempts: 5, delayMs: 0 }), { ok: true });
  assert.equal(calls.length, 3);
  const stuck = { ...page, request: { ...page.request, fetch: async () => { calls.push(1); return { status: () => 409, text: async () => '{}' }; } } };
  calls.length = 0;
  await assert.rejects(() => deleteRobot(stuck, 'robot-1', { attempts: 3, delayMs: 0 }), /HTTP 409/);
  assert.equal(calls.length, 3);
});

test('summarizeEvidence exposes the OpenCode route and the Codex proofs', () => {
  const evidence = { agents: {
    opencode: { probes: {}, turn: { soul: { outcome: 'rate-limited' }, hosted: { answered: true }, answeredBy: 'opencode/x' } },
    codex: { probes: { daemonRunning: true, negativeControl: 'failure' }, turn: 'skipped: no key' },
    pi: { probes: {}, turn: 'skipped: none' },
    claude: { probes: {}, turn: null },
  } };
  const summary = summarizeEvidence(evidence);
  assert.deepEqual(summary.opencode, { soulOutcome: 'rate-limited', hostedFallback: true, answeredBy: 'opencode/x' });
  assert.deepEqual(summary.codex, { daemonRunning: true, negativeControl: 'failure' });
  assert.equal(summary.turns.codex, 'skipped');
  assert.equal(summary.turns.opencode, 'answered');
  assert.equal(summarizeEvidence(null).opencode.soulOutcome, null);
});
