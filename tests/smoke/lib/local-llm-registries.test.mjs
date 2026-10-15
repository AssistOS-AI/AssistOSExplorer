import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { workspacePathHash } from './dgx-spark.mjs';
import {
  SPEC98_INVENTORY, assertBaseUrlBindsBox, boxOf, classifyKeyProbe, judgeRegistriesResults, locateBox,
  requireLocalLlmRegistriesEnvironment, stateFileRestoreStep, toolErrorCode,
} from './local-llm-registries.mjs';

// ---------------------------------------------------------------------------
// Environment, Box and base URL

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llreg-')));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const ROOT = path.join(tmpRoot, 'testExplorerFresh');
fs.mkdirSync(path.join(ROOT, '.ploinky'), { recursive: true });
const BIN = path.join(tmpRoot, 'ploinky');
fs.writeFileSync(BIN, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const GOOD_ENV = Object.freeze({ SMOKE_WORKSPACE_ROOT: ROOT, SMOKE_PLOINKY_BIN: BIN, SMOKE_BASE_URL: 'http://localhost:18080' });
const envWith = (extra) => ({ ...GOOD_ENV, ...extra });

test('a complete environment on linux gives the frozen workspace, binary and base origin', () => {
  const env = requireLocalLlmRegistriesEnvironment(GOOD_ENV, 'linux');
  assert.deepEqual({ ...env }, { workspaceRoot: ROOT, ploinkyBin: BIN, baseURL: 'http://localhost:18080' });
  assert.ok(Object.isFrozen(env));
  assert.equal(requireLocalLlmRegistriesEnvironment(envWith({ SMOKE_BASE_URL: 'http://127.0.0.1:8080/', SMOKE_BOX_BASE_URL: 'http://127.0.0.1:8080' }), 'linux').baseURL, 'http://127.0.0.1:8080');
});

test('the environment check refuses another platform and lists every problem at once', () => {
  assert.throws(() => requireLocalLlmRegistriesEnvironment(GOOD_ENV, 'darwin'), /not darwin/);
  assert.throws(() => requireLocalLlmRegistriesEnvironment({}, 'linux'), (error) => /SMOKE_WORKSPACE_ROOT/.test(error.message)
    && /SMOKE_PLOINKY_BIN/.test(error.message) && /SMOKE_BASE_URL/.test(error.message));
});

test('the environment check refuses a workspace without .ploinky, a symlinked root and a bad binary', () => {
  assert.throws(() => requireLocalLlmRegistriesEnvironment(envWith({ SMOKE_WORKSPACE_ROOT: tmpRoot }), 'linux'), /holds no \.ploinky/);
  const link = path.join(tmpRoot, 'link');
  fs.symlinkSync(ROOT, link);
  assert.throws(() => requireLocalLlmRegistriesEnvironment(envWith({ SMOKE_WORKSPACE_ROOT: link }), 'linux'), /own real path/);
  assert.throws(() => requireLocalLlmRegistriesEnvironment(envWith({ SMOKE_WORKSPACE_ROOT: 'relative' }), 'linux'), /absolute workspace/);
  assert.throws(() => requireLocalLlmRegistriesEnvironment(envWith({ SMOKE_PLOINKY_BIN: path.join(tmpRoot, 'missing') }), 'linux'), /not executable/);
  assert.throws(() => requireLocalLlmRegistriesEnvironment(envWith({ SMOKE_PLOINKY_BIN: 'ploinky' }), 'linux'), /absolute bin\/ploinky/);
});

test('the environment check refuses a set SMOKE_PLOINKY_BOX_CONTAINER', () => {
  assert.throws(() => requireLocalLlmRegistriesEnvironment(envWith({ SMOKE_PLOINKY_BOX_CONTAINER: 'ploinky-box-x-0123456789ab' }), 'linux'), /unset SMOKE_PLOINKY_BOX_CONTAINER/);
});

test('the environment check refuses a non-loopback or portless base URL and a mismatched Box base URL', () => {
  for (const url of ['http://example.com:8080', 'http://10.0.0.5:8080', 'https://localhost:8443', 'http://localhost', '', 'not a url']) {
    assert.throws(() => requireLocalLlmRegistriesEnvironment(envWith({ SMOKE_BASE_URL: url }), 'linux'), /SMOKE_BASE_URL/, url);
  }
  assert.throws(() => requireLocalLlmRegistriesEnvironment(envWith({ SMOKE_BOX_BASE_URL: 'http://localhost:9999' }), 'linux'), /SMOKE_BOX_BASE_URL/);
  assert.throws(() => requireLocalLlmRegistriesEnvironment(envWith({ SMOKE_BOX_BASE_URL: 'garbage' }), 'linux'), /SMOKE_BOX_BASE_URL/);
});

const HASH = workspacePathHash(ROOT);
const BOX_NAME = `ploinky-box-testexplorerfresh-${HASH}`;

function boxRecord(overrides = {}) {
  return {
    Id: 'b'.repeat(64),
    Image: 'sha256:' + 'c'.repeat(64),
    Config: {
      Labels: { 'io.assistos.ploinky-box.role': 'box', 'io.assistos.ploinky-box.path-hash': HASH },
      Env: [`PLOINKY_WORKSPACE_ROOT=${ROOT}`],
      WorkingDir: ROOT,
    },
    Mounts: [{ Type: 'bind', Source: ROOT, Destination: ROOT, RW: true }],
    State: { Running: true, StartedAt: '2026-10-14T10:00:00Z' },
    HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] } },
    ...overrides,
  };
}

// A stub of runCommand: `ps` answers the listed names, `inspect` the records.
function podman({ names = [BOX_NAME], records = [boxRecord()], calls = [] } = {}) {
  return async (command, args) => {
    calls.push([command, ...args]);
    const out = (stdout) => ({ status: 0, signal: null, stdout, stderr: '', error: null });
    if (args[0] === 'ps') return out(names.map((name) => `${name}\n`).join(''));
    if (args[0] === 'container' && args[1] === 'inspect') return out(JSON.stringify(records));
    return { status: 1, signal: null, stdout: '', stderr: 'unexpected', error: null };
  };
}

test('boxOf finds the one running Box through its labels and returns the resolveBox shape without gpu', async () => {
  const calls = [];
  const box = await boxOf({ workspaceRoot: ROOT, run: podman({ calls }) });
  assert.equal(box.name, BOX_NAME);
  assert.equal(box.id, 'b'.repeat(64));
  assert.equal(box.startedAt, '2026-10-14T10:00:00Z');
  assert.equal('gpu' in box, false);
  assert.deepEqual(calls[0].slice(0, 3), ['podman', 'ps', '-a']);
  assert.ok(calls[0].includes(`label=io.assistos.ploinky-box.path-hash=${HASH}`));
});

test('boxOf refuses 0 and 2 listed Boxes, a name with another hash, a stopped Box and a mount of another root', async () => {
  await assert.rejects(boxOf({ workspaceRoot: ROOT, run: podman({ names: [] }) }), /exactly one Box.*listed 0/);
  await assert.rejects(boxOf({ workspaceRoot: ROOT, run: podman({ names: [BOX_NAME, `${BOX_NAME}x`] }) }), /listed 2/);
  await assert.rejects(boxOf({ workspaceRoot: ROOT, run: podman({ names: ['ploinky-box-testexplorerfresh-000000000000'] }) }), /not the Box name/);
  await assert.rejects(boxOf({ workspaceRoot: ROOT, run: podman({ names: [`ploinky-box-other-${HASH}`] }) }), /not the Box name/);
  await assert.rejects(boxOf({ workspaceRoot: ROOT, run: podman({ records: [boxRecord({ State: { Running: false } })] }) }), /not running/);
  const other = boxRecord();
  other.Config.Env = ['PLOINKY_WORKSPACE_ROOT=/elsewhere'];
  other.Config.WorkingDir = '/elsewhere';
  other.Mounts = [{ Type: 'bind', Source: '/elsewhere', Destination: '/elsewhere', RW: true }];
  await assert.rejects(boxOf({ workspaceRoot: ROOT, run: podman({ records: [other] }) }), /binds \/elsewhere/);
  const mislabelled = boxRecord();
  mislabelled.Config.Labels['io.assistos.ploinky-box.path-hash'] = '0'.repeat(12);
  await assert.rejects(boxOf({ workspaceRoot: ROOT, run: podman({ records: [mislabelled] }) }), /not the Box of/);
  await assert.rejects(boxOf({ workspaceRoot: ROOT, run: podman({ records: [boxRecord(), boxRecord()] }) }), /exactly one container/);
});

test('locateBox reports which branch found the Box', async () => {
  const gpuStatus = (stdout, status = 0) => async () => ({ status, stdout, stderr: '', error: null });
  const viaGpu = await locateBox({ ploinky: gpuStatus(`Workspace identity: ${BOX_NAME}\nGPU grant: none\n`), workspaceRoot: ROOT, run: podman() });
  assert.equal(viaGpu.resolvedBy, 'ploinky gpu status');
  assert.equal(viaGpu.name, BOX_NAME);
  const viaLabels = await locateBox({ ploinky: gpuStatus('No GPU on this host\n', 1), workspaceRoot: ROOT, run: podman() });
  assert.equal(viaLabels.resolvedBy, 'podman box labels');
  assert.equal(viaLabels.name, BOX_NAME);
  const noIdentity = await locateBox({ ploinky: gpuStatus('Workspace identity: none\n'), workspaceRoot: ROOT, run: podman() });
  assert.equal(noIdentity.resolvedBy, 'podman box labels');
});

test('assertBaseUrlBindsBox accepts the published port and refuses 8080 for a Box published on 18080', () => {
  const box = { name: BOX_NAME, record: boxRecord() };
  const ok = assertBaseUrlBindsBox({ baseURL: 'http://localhost:18080', box });
  assert.deepEqual(ok, { expected: '127.0.0.1:18080->8080/tcp', current: ['127.0.0.1:18080->8080/tcp'], ok: true });
  assert.throws(() => assertBaseUrlBindsBox({ baseURL: 'http://localhost:8080', box }), /expected 127\.0\.0\.1:8080->8080\/tcp.*127\.0\.0\.1:18080->8080\/tcp/);
  const wide = { name: BOX_NAME, record: boxRecord({ HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '18080' }] } } }) };
  assert.throws(() => assertBaseUrlBindsBox({ baseURL: 'http://localhost:18080', box: wide }), /does not reach the Box/);
  const twice = { name: BOX_NAME, record: boxRecord({ HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }, { HostIp: '127.0.0.1', HostPort: '18081' }] } } }) };
  assert.throws(() => assertBaseUrlBindsBox({ baseURL: 'http://localhost:18080', box: twice }), /does not reach the Box/);
  assert.throws(() => assertBaseUrlBindsBox({ baseURL: 'http://localhost:18080', box: { name: BOX_NAME, record: boxRecord({ HostConfig: {} }) } }), /publishes nothing/);
});

// ---------------------------------------------------------------------------
// toolErrorCode, classifyKeyProbe, stateFileRestoreStep

test('toolErrorCode reads the code of a failing tool reply and nothing else', () => {
  const fail = (text) => ({ ok: false, value: null, text });
  assert.equal(toolErrorCode(fail('MCP error -32603: unsupported_artifact: index manifests are refused')), 'unsupported_artifact');
  assert.equal(toolErrorCode(fail('MCP error -32603: not_found')), 'not_found');
  assert.equal(toolErrorCode(fail('MCP error -32602: address_refused: the address is refused')), 'address_refused');
  assert.equal(toolErrorCode(fail('MCP error -32603: lookup failed: later said not_found')), '');
  assert.equal(toolErrorCode(fail('The registry answered: MCP error -32603: not_found')), '');
  assert.equal(toolErrorCode(fail('unsupported_artifact: index manifests are refused')), '');
  assert.equal(toolErrorCode(fail('MCP error -32603: Unsupported')), '');
  assert.equal(toolErrorCode({ ok: true, value: {}, text: 'MCP error -32603: not_found' }), '');
  assert.equal(toolErrorCode({ ok: false, value: null, text: undefined }), '');
  assert.equal(toolErrorCode(undefined), '');
});

test('classifyKeyProbe maps the probe exit codes', () => {
  assert.deepEqual([0, 3, 4, 125].map(classifyKeyProbe), ['valid', 'absent', 'malformed', 'unknown']);
  assert.equal(classifyKeyProbe(null), 'unknown');
  assert.equal(classifyKeyProbe(undefined), 'unknown');
});

test('stateFileRestoreStep keeps a file that was there and fails when it is gone', () => {
  assert.deepEqual(stateFileRestoreStep({ initiallyPresent: true, currentExit: 0 }), { action: 'kept', ok: true, detail: 'present, as in the initial record' });
  const gone = stateFileRestoreStep({ initiallyPresent: true, currentExit: 1 });
  assert.equal(gone.ok, false);
  assert.match(gone.detail, /initially present file is gone/);
  assert.equal(stateFileRestoreStep({ initiallyPresent: true, currentExit: 125 }).ok, false);
});

test('stateFileRestoreStep: absent then absent is ok with nothing removed (the Q-B shape)', () => {
  const step = stateFileRestoreStep({ initiallyPresent: false, currentExit: 1 });
  assert.deepEqual(step, { action: 'absent', ok: true, detail: 'absent, nothing to remove' });
});

test('stateFileRestoreStep: absent then present is removed by exact path and must then be absent', () => {
  assert.equal(stateFileRestoreStep({ initiallyPresent: false, currentExit: 0, removedExit: 1 }).ok, true);
  assert.equal(stateFileRestoreStep({ initiallyPresent: false, currentExit: 0, removedExit: 1 }).action, 'remove');
  assert.equal(stateFileRestoreStep({ initiallyPresent: false, currentExit: 0, removedExit: 0 }).ok, false);
  assert.equal(stateFileRestoreStep({ initiallyPresent: false, currentExit: 0 }).ok, false);
  assert.equal(stateFileRestoreStep({ initiallyPresent: false, currentExit: 125 }).ok, false);
});

// ---------------------------------------------------------------------------
// judgeRegistriesResults

const A32 = SPEC98_INVENTORY[0].title;

// A valid baseline in Playwright's JSON shape: the file suite, one describe suite per group, one test per spec.
function reportOf(statusOf = () => 'expected', { annotations = {}, errors = [] } = {}) {
  const groups = [...new Set(SPEC98_INVENTORY.map((entry) => entry.group))];
  const stats = { expected: 0, skipped: 0, unexpected: 0, flaky: 0 };
  const suites = groups.map((group) => ({
    title: group,
    specs: SPEC98_INVENTORY.filter((entry) => entry.group === group).map((entry) => {
      const status = statusOf(entry);
      stats[status] += 1;
      return { title: entry.title, ok: status === 'expected', tests: [{ annotations: annotations[entry.title] || [], expectedStatus: 'passed', status, results: [{ status: status === 'skipped' ? 'skipped' : 'passed' }] }] };
    }),
  }));
  return { suites: [{ title: '98-local-llm-model-registries.spec.mjs', specs: [], suites }], errors, stats };
}

// The Q-B shape: A32 failed, the three dependent credential tests skipped, everything else passed.
const qbStatus = (entry) => {
  if (entry.title === A32) return 'unexpected';
  if (entry.group === 'credentials') return 'skipped';
  return 'expected';
};
const QB = Object.freeze({ exitStatus: 1, signal: null, partialFiles: [], a32: { keyProbeExit: 3 } });

test('the inventory lists the five groups in order with the exact A32 title', () => {
  assert.deepEqual([...new Set(SPEC98_INVENTORY.map((entry) => entry.group))], ['credentials', 'negative controls', 'GGUF', 'snapshot', 'final restore']);
  assert.equal(SPEC98_INVENTORY[0].title, 'A32: credential storage is available in the Box agent');
  assert.equal(new Set(SPEC98_INVENTORY.map((entry) => entry.title)).size, SPEC98_INVENTORY.length);
  assert.ok(Object.isFrozen(SPEC98_INVENTORY));
});

test('judge: all passed with exit 0 is passed', () => {
  const verdict = judgeRegistriesResults(reportOf(), { exitStatus: 0, signal: null, partialFiles: [], a32: { keyProbeExit: 0 } });
  assert.equal(verdict.case, 'passed');
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.stats.expected, SPEC98_INVENTORY.length);
  assert.equal(verdict.keyProbe, 'valid');
});

test('judge: a partial annotation, or a partial-snapshot.json file, gives partial and never passed', () => {
  const note = { type: 'partial', description: 'vLLM failed while loading' };
  const snapshotTitle = SPEC98_INVENTORY.find((entry) => entry.group === 'snapshot').title;
  const annotated = judgeRegistriesResults(reportOf(() => 'expected', { annotations: { [snapshotTitle]: [note] } }), { exitStatus: 0, signal: null });
  assert.equal(annotated.case, 'partial');
  assert.equal(annotated.ok, false);
  assert.match(annotated.problems.join(' '), /vLLM failed while loading/);
  const filed = judgeRegistriesResults(reportOf(), { exitStatus: 0, signal: null, partialFiles: ['/x/partial-snapshot.json'] });
  assert.equal(filed.case, 'partial');
  assert.equal(filed.ok, false);
  const onResult = reportOf();
  onResult.suites[0].suites[3].specs[1].tests[0].results[0].annotations = [note];
  assert.equal(judgeRegistriesResults(onResult, { exitStatus: 0, signal: null }).case, 'partial');
  const other = judgeRegistriesResults(reportOf(() => 'expected', { annotations: { [snapshotTitle]: [{ type: 'note', description: 'x' }] } }), { exitStatus: 0, signal: null });
  assert.equal(other.case, 'passed');
});

test('judge: the A32-only shape with exit 1 and a key probe absent or malformed is qb-a32-only', () => {
  for (const [exit, probe] of [[3, 'absent'], [4, 'malformed']]) {
    const verdict = judgeRegistriesResults(reportOf(qbStatus), { ...QB, a32: { keyProbeExit: exit } });
    assert.equal(verdict.case, 'qb-a32-only');
    assert.equal(verdict.ok, false);
    assert.equal(verdict.keyProbe, probe);
  }
});

function assertFailed(report, options, pattern) {
  const verdict = judgeRegistriesResults(report, options);
  assert.equal(verdict.case, 'failed', JSON.stringify(verdict));
  assert.equal(verdict.ok, false);
  if (pattern) assert.match(verdict.problems.join(' | '), pattern);
  return verdict;
}

test('judge: the A32-only shape with a valid or unknown key probe is a failure, never Q-B', () => {
  assertFailed(reportOf(qbStatus), { ...QB, a32: { keyProbeExit: 0 } }, /candidate defect/);
  assertFailed(reportOf(qbStatus), { ...QB, a32: { keyProbeExit: 125 } }, /unattributed/);
  assertFailed(reportOf(qbStatus), { ...QB, a32: null });
});

test('judge: report errors, a signal and an exit other than 0 or 1 fail the A32-only shape', () => {
  assertFailed(reportOf(qbStatus, { errors: [{ message: 'worker crashed' }] }), QB, /global or worker error/);
  assertFailed(reportOf(qbStatus), { ...QB, signal: 'SIGKILL' }, /SIGKILL/);
  assertFailed(reportOf(qbStatus), { ...QB, exitStatus: 130 }, /exited 130/);
  assertFailed(reportOf(qbStatus), { ...QB, exitStatus: null }, /exited null/);
  assertFailed(null, QB, /missing/);
});

test('judge: a missing test or a missing group fails the A32-only shape', () => {
  const noLeakScan = reportOf(qbStatus);
  noLeakScan.suites[0].suites[0].specs.pop();
  assertFailed(noLeakScan, QB, /missing test "credentials: leak scan"/);
  const noGguf = reportOf(qbStatus);
  noGguf.suites[0].suites = noGguf.suites[0].suites.filter((suite) => suite.title !== 'GGUF');
  assertFailed(noGguf, QB, /missing test.*GGUF/);
  assertFailed({ suites: [], errors: [], stats: { expected: 0, skipped: 0, unexpected: 0, flaky: 0 } }, { exitStatus: 0, signal: null }, /missing test/);
});

test('judge: an extra or duplicated test fails', () => {
  const extra = reportOf();
  extra.suites[0].suites[1].specs.push({ title: 'one more', tests: [{ status: 'expected', annotations: [], results: [] }] });
  assertFailed(extra, { exitStatus: 0, signal: null }, /extra test "one more"/);
  const twice = reportOf();
  twice.suites[0].suites[4].specs.push(structuredClone(twice.suites[0].suites[4].specs[0]));
  assertFailed(twice, { exitStatus: 0, signal: null }, /duplicate test/);
});

test('judge: a dependent credential test expected instead of skipped fails the A32-only shape', () => {
  const dependent = SPEC98_INVENTORY[1].title;
  assertFailed(reportOf((entry) => (entry.title === dependent ? 'expected' : qbStatus(entry))), QB);
});

test('judge: A32 failed plus a GGUF failure, and A32 passed with the restart test failed, are failures', () => {
  const gguf = SPEC98_INVENTORY.find((entry) => entry.group === 'GGUF').title;
  assertFailed(reportOf((entry) => (entry.title === gguf ? 'unexpected' : qbStatus(entry))), QB, /failed: GGUF/);
  const restart = SPEC98_INVENTORY[2].title;
  const verdict = assertFailed(reportOf((entry) => (entry.title === restart ? 'unexpected' : entry.title === SPEC98_INVENTORY[3].title ? 'skipped' : 'expected')),
    { exitStatus: 1, signal: null, a32: { keyProbeExit: 0 } }, /failed: credentials: the credential survives/);
  assert.equal(verdict.keyProbe, 'valid');
});

test('judge: a flaky test, a skipped test in a passing run and exit 1 without a failed test fail', () => {
  const gguf = SPEC98_INVENTORY.find((entry) => entry.group === 'GGUF').title;
  assertFailed(reportOf((entry) => (entry.title === gguf ? 'flaky' : 'expected')), { exitStatus: 0, signal: null }, /flaky/);
  assertFailed(reportOf((entry) => (entry.title === gguf ? 'skipped' : 'expected')), { exitStatus: 0, signal: null }, /skipped/);
  assertFailed(reportOf(), { exitStatus: 1, signal: null, a32: { keyProbeExit: 3 } });
  assertFailed(reportOf((entry) => (entry.title === gguf ? 'flaky' : qbStatus(entry))), QB);
});

test('judge: a report whose counters say passed but whose tests do not is not passed', () => {
  const report = reportOf();
  report.suites[0].suites[2].specs[0].tests[0].status = 'unexpected';
  assert.notEqual(judgeRegistriesResults(report, { exitStatus: 0, signal: null }).case, 'passed');
});

// ---------------------------------------------------------------------------
// Imports

// The names a module imports, by specifier, read from its source.
function importsOf(file) {
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const found = {};
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    found[match[2]] = [...(found[match[2]] || []), ...match[1].split(',').map((name) => name.trim()).filter(Boolean)];
  }
  return found;
}

test('the lib imports exactly the helpers the plan names, from the modules the plan names', () => {
  const imports = importsOf('./local-llm-registries.mjs');
  assert.deepEqual([...imports['./dgx-spark.mjs']].sort(), ['boxPublications', 'resolveBox', 'runCommand', 'workspacePathHash']);
  assert.deepEqual(imports['./box-workspace.mjs'], ['inspectBoxWorkspace']);
  assert.deepEqual(imports['../scripts/run-dgx-spark-e2e.mjs'], ['judgeResults']);
  assert.deepEqual(Object.keys(imports).sort(), ['../scripts/run-dgx-spark-e2e.mjs', './box-workspace.mjs', './dgx-spark.mjs']);
});

test('the spec and the runner import their lib names and none of the DGX gate helpers', () => {
  const spec = importsOf('../specs/98-local-llm-model-registries.spec.mjs');
  assert.deepEqual([...spec['../lib/local-llm-registries.mjs']].sort(), [
    'SPEC98_INVENTORY', 'assertBaseUrlBindsBox', 'classifyKeyProbe', 'locateBox', 'requireLocalLlmRegistriesEnvironment', 'stateFileRestoreStep', 'toolErrorCode',
  ]);
  const runner = importsOf('../scripts/run-local-llm-registries-e2e.mjs');
  assert.deepEqual([...runner['../lib/local-llm-registries.mjs']].sort(), ['assertBaseUrlBindsBox', 'judgeRegistriesResults', 'locateBox', 'requireLocalLlmRegistriesEnvironment']);
  assert.deepEqual(runner['../lib/dgx-spark.mjs'], ['createPloinky']);
  for (const file of ['./local-llm-registries.mjs', '../specs/98-local-llm-model-registries.spec.mjs', '../scripts/run-local-llm-registries-e2e.mjs']) {
    const names = Object.values(importsOf(file)).flat();
    for (const forbidden of ['dgxSparkEnabled', 'requireDgxSparkEnvironment', 'errorCodeOf']) assert.equal(names.includes(forbidden), false, `${file} must not import ${forbidden}`);
  }
});
