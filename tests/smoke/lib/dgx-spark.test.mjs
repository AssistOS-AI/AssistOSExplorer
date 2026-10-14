import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveMemoryPercent } from './hardware-limits-evidence.mjs';
import {
  GIB, classifyComputeApps, createCommandDevices, createCommandFlags, errorCodeOf, nestedNameOf, parseComputeApps, parseGpuQuery,
  parseGpuStatus, parseLimitsStatus, requireDgxSparkEnvironment, unifiedFitPercent, unifiedRefusePercent,
  reserveInBudgetFitPercent,
} from './dgx-spark.mjs';

const GPU_STATUS = `Workspace identity: ploinky-box-testexplorerfresh-8b021738a3d6
GPU grant: none
GPU agents: local-llms/local-llm (manifest)
Manifest GPU declarations: local-llms/local-llm
Host GPU: nvidia driver 580.178.04; devices /dev/nvidia0, /dev/nvidiactl, /dev/nvidia-uvm; libraries libcuda.so.1
Box: running; GPU wiring active 7a03d6aa7368
Desired GPU wiring: active 7a03d6aa7368
`;

test('parseGpuStatus reads the instance, agents and both wiring fingerprints', () => {
  const parsed = parseGpuStatus(GPU_STATUS);
  assert.equal(parsed.instance, 'ploinky-box-testexplorerfresh-8b021738a3d6');
  assert.deepEqual(parsed.agents, [{ ref: 'local-llms/local-llm', source: 'manifest' }]);
  assert.deepEqual(parsed.manifestDeclarations, ['local-llms/local-llm']);
  assert.equal(parsed.boxState, 'running');
  assert.equal(parsed.wiring, 'active');
  assert.equal(parsed.wiringFingerprint, '7a03d6aa7368');
  assert.equal(parsed.desiredFingerprint, '7a03d6aa7368');
  assert.match(parsed.hostGpu, /driver 580\.178\.04/);
});

test('parseGpuStatus reads a revoke: no agents, the denial and the marker-only wiring', () => {
  const parsed = parseGpuStatus(GPU_STATUS.replace('GPU grant: none', 'GPU grant: denied local-llms/local-llm')
    .replace('GPU agents: local-llms/local-llm (manifest)', 'GPU agents: none')
    .replace('Box: running; GPU wiring active 7a03d6aa7368', 'Box: running; GPU wiring revoked 90c5c18ba1db (marker only)')
    .replace('Desired GPU wiring: active 7a03d6aa7368', 'Desired GPU wiring: revoked 90c5c18ba1db (marker only)'));
  assert.deepEqual(parsed.agents, []);
  assert.equal(parsed.grant, 'denied local-llms/local-llm');
  assert.equal(parsed.wiring, 'revoked');
  assert.equal(parsed.wiringFingerprint, '90c5c18ba1db');
  assert.equal(parsed.desiredWiring, 'revoked');
  assert.equal(parsed.desiredFingerprint, '90c5c18ba1db');
});

test('parseLimitsStatus reads the gate from the saved and never-set forms', () => {
  assert.equal(parseLimitsStatus('Workspace identity: x\nHardware limits: off (never set)\n').gate, 'off');
  const on = parseLimitsStatus('Hardware limits: on (saved 2026-10-14T09:26:44.241Z)\nHost delegation: cgroup v2; controllers cpu memory pids\n');
  assert.equal(on.gate, 'on');
  assert.match(on.hostDelegation, /controllers cpu memory pids/);
  assert.equal(parseLimitsStatus('Hardware limits: unknown\n').gate, '');
});

test('createCommandDevices and createCommandFlags read both flag spellings', () => {
  const argv = ['podman', 'create', '--device', '/dev/nvidia0', '--device=/dev/fuse', '--device', 'ploinky.local/gpu=all', '-v', '/a:/b:ro', '--volume=/c:/d:ro', '--gpus'];
  assert.deepEqual(createCommandDevices(argv), ['/dev/nvidia0', '/dev/fuse', 'ploinky.local/gpu=all']);
  assert.deepEqual(createCommandFlags(argv, '-v'), ['/a:/b:ro']);
  assert.deepEqual(createCommandFlags(argv, '--volume'), ['/c:/d:ro']);
  assert.deepEqual(createCommandFlags(argv, '--gpus'), []);
  assert.deepEqual(createCommandDevices(null), []);
});

test('parseGpuQuery requires exactly one row of the queried fields', () => {
  const row = 'NVIDIA GB10, 0x2E1210DE, 12.1, ATS, 580.178.04, [N/A], GPU-01234567-89ab-cdef-0123-456789abcdef';
  assert.deepEqual(parseGpuQuery(`${row}\n`), {
    name: 'NVIDIA GB10', pciDeviceId: '0x2E1210DE', computeCapability: '12.1', addressingMode: 'ATS', driverVersion: '580.178.04', memoryTotal: '[N/A]', uuid: 'GPU-01234567-89ab-cdef-0123-456789abcdef',
  });
  assert.throws(() => parseGpuQuery(`${row}\n${row}\n`), /one GPU row/);
  assert.throws(() => parseGpuQuery('NVIDIA GB10, 0x2E1210DE\n'), /7 fields/);
});

test('compute processes are split by the Box scope in their host cgroup', () => {
  const apps = parseComputeApps('97752, /opt/llama.cpp/llama-server, 1212 MiB\n4242, python3, 300 MiB\n77, gone, 1 MiB\n');
  assert.deepEqual(apps.map((app) => app.usedMiB), [1212, 300, 1]);
  const boxId = 'a'.repeat(64);
  const cgroups = { 97752: `/user.slice/libpod-${boxId}.scope/container/ploinky/agents/libpod-${'b'.repeat(64)}`, 4242: '/user.slice/other.scope', 77: null };
  const { owned, foreign } = classifyComputeApps(apps, boxId, (pid) => cgroups[pid]);
  assert.deepEqual(owned.map((app) => app.pid), [97752]);
  assert.deepEqual(foreign.map((app) => app.pid), [4242]);
});

test('nestedNameOf finds exactly one container of a manifest agent', () => {
  const entries = [{ name: 'ploinky_local-llms_local-llm_testExplorerFresh_8b021738' }, { name: 'ploinky_AchillesIDE_explorer_testExplorerFresh_8b021738' }];
  assert.equal(nestedNameOf(entries, 'local-llms/local-llm'), 'ploinky_local-llms_local-llm_testExplorerFresh_8b021738');
  assert.throws(() => nestedNameOf(entries, 'proxies/soul-gateway'), /found 0/);
});

test('errorCodeOf prefers the structured code and falls back to the message', () => {
  assert.equal(errorCodeOf({ value: { code: 'admission_incompatible' }, text: '' }), 'admission_incompatible');
  assert.equal(errorCodeOf({ value: null, text: 'Error admission_insufficient_now: Needs about 10.8 GiB' }), 'admission_insufficient_now');
  assert.equal(errorCodeOf({ value: null, text: 'nothing typed' }), '');
});

test('the unified fit and refusal percentages bracket the need', () => {
  const envelopeBytes = 128450985984;
  const needBytes = 11579755688;
  const usedBytes = GIB;
  const fit = unifiedFitPercent({ needBytes, envelopeBytes, usedBytes });
  const refuse = unifiedRefusePercent({ needBytes, envelopeBytes });
  const budget = (percent) => resolveMemoryPercent(percent, envelopeBytes);
  assert.ok(budget(fit) - usedBytes >= needBytes, 'the fit budget holds the need beside the agent\'s use');
  assert.ok(budget(fit - 1) - usedBytes < needBytes + 2 * GIB, 'the fit percentage is the smallest that keeps the margin');
  assert.ok(budget(refuse) < needBytes, 'the refusal budget is below the need');
  assert.ok(budget(refuse) <= needBytes - GIB, 'the refusal budget is at least 1 GiB below the need');
  assert.ok(budget(refuse + 1) > needBytes - GIB, 'the refusal percentage is the largest that stays 1 GiB below the need');
  assert.ok(refuse < fit);
  assert.throws(() => unifiedFitPercent({ needBytes: envelopeBytes, envelopeBytes }), /cannot fit/);
  assert.throws(() => unifiedRefusePercent({ needBytes: GIB, envelopeBytes }), /No RAM percentage/);
});

test('the unified brackets move by one percent across need +/- 1 MiB at an exact percentage boundary', () => {
  const MIB = 1024 * 1024;
  const envelopeBytes = 200 * GIB;
  // need + used + margin = 60 GiB is exactly 30% of the envelope.
  const fitNeed = 58 * GIB;
  assert.equal(unifiedFitPercent({ needBytes: fitNeed, envelopeBytes }), 30);
  assert.equal(unifiedFitPercent({ needBytes: fitNeed - MIB, envelopeBytes }), 30);
  assert.equal(unifiedFitPercent({ needBytes: fitNeed + MIB, envelopeBytes }), 31);
  assert.equal(unifiedFitPercent({ needBytes: fitNeed - 1 * GIB, usedBytes: GIB, envelopeBytes }), 30);
  assert.equal(unifiedFitPercent({ needBytes: fitNeed - 1 * GIB + MIB, usedBytes: GIB, envelopeBytes }), 31);
  // need - 1 GiB = 60 GiB is exactly 30%.
  const refuseNeed = 61 * GIB;
  assert.equal(unifiedRefusePercent({ needBytes: refuseNeed, envelopeBytes }), 30);
  assert.equal(unifiedRefusePercent({ needBytes: refuseNeed + MIB, envelopeBytes }), 30);
  assert.equal(unifiedRefusePercent({ needBytes: refuseNeed - MIB, envelopeBytes }), 29);
  for (const needBytes of [refuseNeed - MIB, refuseNeed, refuseNeed + MIB]) {
    const budget = resolveMemoryPercent(unifiedRefusePercent({ needBytes, envelopeBytes }), envelopeBytes);
    assert.ok(budget < needBytes, `budget ${budget} refuses need ${needBytes}`);
  }
  for (const needBytes of [fitNeed - MIB, fitNeed, fitNeed + MIB]) {
    const budget = resolveMemoryPercent(unifiedFitPercent({ needBytes, envelopeBytes }), envelopeBytes);
    assert.ok(budget >= needBytes, `budget ${budget} holds need ${needBytes}`);
  }
});

test('the unified brackets hold with MiB-floored budgets on the non-MiB-aligned GB10 envelope', () => {
  const envelopeBytes = 128450985984;
  assert.notEqual(envelopeBytes % (1024 * 1024), 0);
  for (const needBytes of [11579755688 - 1024 * 1024, 11579755688, 11579755688 + 1024 * 1024]) {
    for (const usedBytes of [0, GIB]) {
      const fit = resolveMemoryPercent(unifiedFitPercent({ needBytes, envelopeBytes, usedBytes }), envelopeBytes);
      assert.ok(fit - usedBytes >= needBytes, `fit budget ${fit} holds need ${needBytes} and use ${usedBytes}`);
    }
    const refuse = resolveMemoryPercent(unifiedRefusePercent({ needBytes, envelopeBytes }), envelopeBytes);
    assert.ok(refuse <= needBytes - GIB, `refusal budget ${refuse} is 1 GiB below need ${needBytes}`);
  }
});

test('reserveInBudgetFitPercent keeps the pre-change rule, which charged the host reserve inside the budget', () => {
  const envelopeBytes = 128450985984;
  const needBytes = 11579755688;
  const old = reserveInBudgetFitPercent({ needBytes, envelopeBytes, usedBytes: GIB });
  const budget = (percent) => resolveMemoryPercent(percent, envelopeBytes);
  assert.ok(budget(old) - 16 * GIB >= needBytes, 'the old budget clears the host reserve');
  assert.ok(budget(old) - 8 * GIB - GIB >= needBytes, 'the old budget clears the floor and the agent\'s use');
  assert.ok(unifiedFitPercent({ needBytes, envelopeBytes, usedBytes: GIB }) < old, 'the current fit percentage is below the old rule');
  assert.throws(() => reserveInBudgetFitPercent({ needBytes: envelopeBytes, envelopeBytes }), /cannot fit/);
});

test('requireDgxSparkEnvironment fails closed without a workspace or with a named Box', () => {
  assert.throws(() => requireDgxSparkEnvironment({}), /SMOKE_WORKSPACE_ROOT/);
  assert.throws(() => requireDgxSparkEnvironment({ SMOKE_WORKSPACE_ROOT: '/nonexistent', SMOKE_PLOINKY_BIN: '/bin/true', SMOKE_PLOINKY_BOX_CONTAINER: 'ploinky-box-x-0123456789ab' }), /unset SMOKE_PLOINKY_BOX_CONTAINER/);
});

test('the DGX wrapper selects specs by number and refuses anything else', async () => {
  const { DGX_SPECS, parseDgxArgs } = await import('../scripts/run-dgx-spark-e2e.mjs');
  assert.deepEqual(parseDgxArgs([]).specs, DGX_SPECS);
  assert.deepEqual(parseDgxArgs(['--spec', '95', '--spec', '93']).specs, ['specs/93-dgx-spark-platform.spec.mjs', 'specs/95-dgx-spark-hardware-limits.spec.mjs']);
  assert.equal(parseDgxArgs(['--list']).list, true);
  assert.deepEqual(parseDgxArgs(['--spec', '97']).specs, ['specs/97-dgx-spark-vllm.spec.mjs']);
  assert.equal(DGX_SPECS.length, 5);
  assert.throws(() => parseDgxArgs(['--spec', '91']), /--spec must be one of/);
  assert.throws(() => parseDgxArgs(['--grep', 'x']), /Unknown option/);
  assert.throws(() => parseDgxArgs(['--retries=1']), /Unknown option/);
});

test('the DGX wrapper passes only when every discovered test passed', async () => {
  const { judgeResults } = await import('../scripts/run-dgx-spark-e2e.mjs');
  assert.equal(judgeResults({ stats: { expected: 6, skipped: 0, unexpected: 0, flaky: 0 } }).ok, true);
  assert.deepEqual(judgeResults({ stats: { expected: 5, skipped: 1, unexpected: 0, flaky: 0 } }).problems, ['1 skipped']);
  assert.deepEqual(judgeResults({ stats: { expected: 5, skipped: 0, unexpected: 1, flaky: 0 } }).problems, ['1 unexpected']);
  assert.deepEqual(judgeResults({ stats: { expected: 0, skipped: 0, unexpected: 0, flaky: 0 } }).problems, ['no test passed']);
  assert.equal(judgeResults(null).ok, false);
});

test('every ploinky call pins the workspace and drops an inherited gate request', async () => {
  const { ploinkyEnvironment, workspacePathHash } = await import('./dgx-spark.mjs');
  const base = { PATH: '/usr/bin', PLOINKY_WORKSPACE_ROOT: '/home/u/other', PLOINKY_BOX_HARDWARE_LIMITS: 'off' };
  const plain = ploinkyEnvironment('/home/u/work/testExplorerFresh', {}, base);
  assert.equal(plain.PLOINKY_WORKSPACE_ROOT, '/home/u/work/testExplorerFresh');
  assert.equal('PLOINKY_BOX_HARDWARE_LIMITS' in plain, false);
  assert.equal(plain.PATH, '/usr/bin');
  assert.equal(ploinkyEnvironment('/w', { PLOINKY_BOX_HARDWARE_LIMITS: 'on' }, base).PLOINKY_BOX_HARDWARE_LIMITS, 'on');
  assert.equal(base.PLOINKY_BOX_HARDWARE_LIMITS, 'off', 'the inherited environment is not mutated');
  // The Box instance suffix observed for /home/daniel/work/testExplorerFresh on the Spark.
  assert.equal(workspacePathHash('/home/daniel/work/testExplorerFresh'), '8b021738a3d6');
});

test('requireDgxSparkEnvironment refuses a symlinked workspace spelling', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgx-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'real', '.ploinky'), { recursive: true });
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'alias'));
  const env = { SMOKE_PLOINKY_BIN: '/bin/true' };
  if (process.platform === 'linux' && process.arch === 'arm64') {
    assert.equal(requireDgxSparkEnvironment({ ...env, SMOKE_WORKSPACE_ROOT: path.join(fs.realpathSync(dir), 'real') }).workspaceRoot, path.join(fs.realpathSync(dir), 'real'));
  }
  assert.throws(() => requireDgxSparkEnvironment({ ...env, SMOKE_WORKSPACE_ROOT: path.join(fs.realpathSync(dir), 'alias') }), /must be its own real path/);
});
