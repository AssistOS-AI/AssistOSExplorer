import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  A5_TOLERATED_MAX_MIB,
  EvidenceBlocked,
  INFERENCE_MIN_IN_FLIGHT,
  agentByRef,
  agentLeafPath,
  assertNoCredentials,
  boxCgroupPrefix,
  boxPrefixFromInit,
  checked,
  classifyObservation,
  coreArgs,
  cpuMaxMatches,
  createEvidenceWriter,
  createHardwareApi,
  createHostObserver,
  createIdleGate,
  diffRunningSets,
  evaluateIdleGate,
  findMpsDaemon,
  findSingleInstanceAgent,
  hostRunnerIdentities,
  inFlightCounts,
  instanceByKey,
  loadDeployedAnalysis,
  measureInference,
  meetsInFlightMinimums,
  nestedArgs,
  onlyExpectedChanged,
  parseGpuInventory,
  parseGpuMemory,
  parseGpuUtilization,
  parseLeafSample,
  parseProof,
  readHostGpuIdentity,
  readLeaf,
  readMpsDaemon,
  readRunningSet,
  readRunnerDigest,
  readRunnerProcesses,
  refusalCode,
  removeFixture,
  requireHardwareEnvironment,
  resolveMemoryPercent,
  runnerIdentity,
  sameToken,
  sanitizeEvidence,
  shareMemoryMiB,
  summarizeGpuCheck,
  tokenOf,
  validateBoxName,
  waitFor,
} from './hardware-limits-evidence.mjs';

const UUID = 'GPU-905b8484-3b1e-30f6-defd-05d44f00f692';
const BOX = 'ploinky-box-hwlreleasepre-0123456789ab';
const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const ID_C = 'c'.repeat(64);
const MIB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Fixtures

function gpuXml({ uuid = UUID, mode = 'Default', processes = [], total = 6144, used = 2, processesSection = true, extra = '' } = {}) {
  const rows = processes.map((row) => `<process_info><gpu_instance_id>N/A</gpu_instance_id><compute_instance_id>N/A</compute_instance_id><pid>${row.pid}</pid><type>${row.type}</type><process_name>${row.name ?? 'x'}</process_name>${row.memory === undefined ? '' : `<used_memory>${row.memory} MiB</used_memory>`}</process_info>`).join('');
  return `<?xml version="1.0" ?><nvidia_smi_log><gpu id="00000000:01:00.0"><uuid>${uuid}</uuid><compute_mode>${mode}</compute_mode><fb_memory_usage><total>${total} MiB</total><reserved>1 MiB</reserved><used>${used} MiB</used><free>${total - used} MiB</free></fb_memory_usage><utilization><gpu_util>7 %</gpu_util></utilization>${processesSection ? `<processes>${rows}</processes>` : ''}${extra}</gpu></nvidia_smi_log>`;
}

function hostWorld(entries, extraCgroups = []) {
  // entries: { pid: {startIdentity, cgroup, nspid, ppid, uid} }
  const bootId = 'boot-1';
  return {
    bootId: () => bootId,
    observe: (pid) => (entries[pid] ? { hostPid: pid, bootId, ppid: 1, comm: '', uid: [1000, 1000, 1000, 1000], nspid: [pid], ...entries[pid] } : null),
    scan: () => Object.keys(entries).map(Number),
    cgroupProcs: (cgroupPath) => {
      const members = Object.keys(entries).filter((pid) => entries[pid] && entries[pid].cgroup === cgroupPath).map(Number);
      return members.length || (extraCgroups || []).includes(cgroupPath) ? members : null;
    },
  };
}

const BOX_PREFIX = '/user.slice/box.scope';

// ---------------------------------------------------------------------------
// Arithmetic

test('cpuMaxMatches accepts the exact quota and the truncated one at period 100000, nothing else', () => {
  assert.equal(cpuMaxMatches('400000 100000', 4), true);
  assert.equal(cpuMaxMatches('399999 100000\n', 4), true);
  assert.equal(cpuMaxMatches('50000 100000', 0.5), true);
  assert.equal(cpuMaxMatches('49999 100000', '0.50'), true);
  assert.equal(cpuMaxMatches('399998 100000', 4), false);
  assert.equal(cpuMaxMatches('400000 50000', 4), false);
  assert.equal(cpuMaxMatches('max 100000', 4), false);
  assert.equal(cpuMaxMatches(null, 4), false);
});

test('resolveMemoryPercent floors to whole MiB and refuses what the product refuses', () => {
  assert.equal(resolveMemoryPercent(25, 32_820_428_800), 8_205_107_200);
  assert.equal(resolveMemoryPercent(4, 32_820_428_800), 1_312_817_152);
  assert.throws(() => resolveMemoryPercent(0, 1 << 30), /1 to 100/);
  assert.throws(() => resolveMemoryPercent(50.5, 1 << 30), /1 to 100/);
  assert.throws(() => resolveMemoryPercent(1, 100 * MIB), /below the 64 MiB minimum/);
  assert.throws(() => resolveMemoryPercent(10, 0), /unknown/);
});

test('command helpers validate the Box name and report failures without output leakage', () => {
  assert.equal(validateBoxName(BOX), BOX);
  for (const bad of ['', '../x', 'a b', 'x;y', '-rf', undefined]) assert.throws(() => validateBoxName(bad), /Box container name/);
  assert.deepEqual(coreArgs(BOX), ['container', 'exec', '--user', 'podman', BOX]);
  assert.deepEqual(nestedArgs(BOX).slice(-2), ['podman', '--cgroup-manager=cgroupfs']);
  assert.equal(checked({ status: 0, stdout: 'ok' }, 'x'), 'ok');
  assert.throws(() => checked({ status: 3, stdout: 'secret-stdout', stderr: 'boom' }, 'Probe'), (error) => /Probe failed \(exit 3: boom\)/.test(error.message) && !/secret-stdout/.test(error.message));
  assert.throws(() => checked({ status: null, error: new Error('timed out') }, 'Probe'), /timed out/);
});

// ---------------------------------------------------------------------------
// Leaf reader

const LEAF = `/sys/fs/cgroup/ploinky/agents/libpod-${ID_A}`;
function leafReply(overrides = {}) {
  return {
    leaf: LEAF,
    atNs: '123456789000',
    'cpu.stat': 'usage_usec 1000\nuser_usec 900\nsystem_usec 100\nnr_periods 5\nnr_throttled 1\nthrottled_usec 77\n',
    'cpu.max': '400000 100000\n',
    'memory.max': '8205107200\n',
    'memory.swap.max': '0\n',
    'memory.current': '4096\n',
    'memory.swap.current': '0\n',
    'memory.peak': null,
    'memory.events': 'low 0\nhigh 0\nmax 2\noom 0\noom_kill 0\n',
    'pids.max': '64\n',
    'pids.current': '3\n',
    ...overrides,
  };
}

test('parseLeafSample reads numbers and leaves every unreadable value null', () => {
  const sample = parseLeafSample(leafReply());
  assert.equal(sample.atUs, 123456789);
  assert.equal(sample.usageUsec, 1000);
  assert.equal(sample.nrThrottled, 1);
  assert.equal(sample.cpuMax, '400000 100000');
  assert.equal(sample.memoryMax, '8205107200');
  assert.equal(sample.swapMax, '0');
  assert.equal(sample.pidsMax, '64');
  assert.equal(sample.memoryPeak, null);
  assert.equal(sample.oomKill, 0);
  assert.equal(sample.memoryMaxEvents, 2);
  const empty = parseLeafSample({ atNs: 'x' });
  assert.equal(empty.atUs, null);
  assert.equal(empty.usageUsec, null);
  assert.equal(empty.oomKill, null);
});

test('readLeaf runs one program as the Box user and refuses a leaf outside the agents hierarchy', async () => {
  const calls = [];
  const run = (command, args) => { calls.push({ command, args }); return { status: 0, stdout: JSON.stringify(leafReply()) }; };
  const read = await readLeaf({ run, boxName: BOX, containerId: ID_A });
  assert.equal(read.leaf, LEAF);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'podman');
  assert.deepEqual(calls[0].args.slice(0, 5), coreArgs(BOX));
  assert.equal(calls[0].args.at(-1), ID_A);
  assert.equal(calls[0].args.includes('node'), true);
  const outside = () => ({ status: 0, stdout: JSON.stringify(leafReply({ leaf: '/sys/fs/cgroup/ploinky/core' })) });
  await assert.rejects(() => readLeaf({ run: outside, boxName: BOX, containerId: ID_A }), /outside the agents hierarchy/);
  await assert.rejects(() => readLeaf({ run: () => ({ status: 0, stdout: 'not json' }), boxName: BOX, containerId: ID_A }), /invalid JSON/);
  await assert.rejects(() => readLeaf({ run: () => ({ status: 1, stdout: '', stderr: 'no leaf' }), boxName: BOX, containerId: ID_A }), /Leaf read failed/);
});

// ---------------------------------------------------------------------------
// Running set

function fakeEngine(records) {
  return (command, args) => {
    if (args.includes('ls')) return { status: 0, stdout: `${records.map((record) => record.Id).join('\n')}\n` };
    if (args.includes('inspect')) return { status: 0, stdout: JSON.stringify(records) };
    return { status: 2, stdout: '', stderr: 'unexpected' };
  };
}
const rec = (Id, Name, StartedAt, Running = true) => ({ Id, Name: `/${Name}`, State: { Running, StartedAt } });

test('readRunningSet returns each nested container id, name and StartedAt, sorted, through the core observer', async () => {
  const seen = [];
  const engine = fakeEngine([rec(ID_B, 'zeta', '2026-10-04T10:00:02Z'), rec(ID_A, 'alpha', '2026-10-04T10:00:01Z')]);
  const set = await readRunningSet({ run: (command, args) => { seen.push(args); return engine(command, args); }, boxName: BOX });
  assert.deepEqual(set, [{ id: ID_A, name: 'alpha', startedAt: '2026-10-04T10:00:01Z' }, { id: ID_B, name: 'zeta', startedAt: '2026-10-04T10:00:02Z' }]);
  assert.deepEqual(seen[0].slice(0, 7), [...coreArgs(BOX), 'podman', '--cgroup-manager=cgroupfs']);
  assert.deepEqual(await readRunningSet({ run: fakeEngine([]), boxName: BOX }), []);
});

test('readRunningSet rejects malformed identities, stopped records and partial inspection', async () => {
  await assert.rejects(() => readRunningSet({ run: () => ({ status: 0, stdout: 'abc\n' }), boxName: BOX }), /malformed identity/);
  await assert.rejects(() => readRunningSet({ run: fakeEngine([rec(ID_A, 'alpha', '2026-10-04T10:00:01Z', false)]), boxName: BOX }), /incomplete or stopped/);
  await assert.rejects(() => readRunningSet({ run: fakeEngine([rec(ID_A, 'alpha', '')]), boxName: BOX }), /incomplete or stopped/);
  const partial = (command, args) => (args.includes('ls') ? { status: 0, stdout: `${ID_A}\n${ID_B}\n` } : { status: 0, stdout: JSON.stringify([rec(ID_A, 'alpha', 't')]) });
  await assert.rejects(() => readRunningSet({ run: partial, boxName: BOX }), /one record per container/);
  await assert.rejects(() => readRunningSet({ run: () => ({ status: 1, stdout: '', stderr: 'engine down' }), boxName: BOX }), /listing failed/);
});

test('diffRunningSets names added, removed and recreated identities and onlyExpectedChanged is exact', () => {
  const before = [{ id: ID_A, name: 'alpha', startedAt: 't1' }, { id: ID_B, name: 'beta', startedAt: 't1' }, { id: ID_C, name: 'gamma', startedAt: 't1' }];
  const same = diffRunningSets(before, before);
  assert.deepEqual(same, { added: [], removed: [], restarted: [], changed: [] });
  assert.equal(onlyExpectedChanged(same, []), true);
  const recreated = before.map((entry) => (entry.name === 'beta' ? { ...entry, id: 'd'.repeat(64), startedAt: 't2' } : entry));
  const diff = diffRunningSets(before, recreated);
  assert.deepEqual(diff.restarted, ['beta']);
  assert.equal(onlyExpectedChanged(diff, ['beta']), true);
  assert.equal(onlyExpectedChanged(diff, ['alpha']), false);
  assert.equal(onlyExpectedChanged(diff, ['beta', 'alpha']), false);
  const sameIdNewStart = before.map((entry) => (entry.name === 'gamma' ? { ...entry, startedAt: 't9' } : entry));
  assert.deepEqual(diffRunningSets(before, sameIdNewStart).restarted, ['gamma']);
  const withExtra = [...recreated, { id: 'e'.repeat(64), name: 'extra', startedAt: 't3' }].filter((entry) => entry.name !== 'alpha');
  const wide = diffRunningSets(before, withExtra);
  assert.deepEqual(wide, { added: ['extra'], removed: ['alpha'], restarted: ['beta'], changed: ['alpha', 'beta', 'extra'] });
  assert.equal(onlyExpectedChanged(wide, ['beta']), false);
});

// ---------------------------------------------------------------------------
// Runner identity

const SHARE = { smPercent: 50, memory: '0=3072M' };
function runner(overrides = {}) {
  return {
    pid: 42,
    exe: '/opt/llama.cpp/llama-server',
    start: '9001',
    uid: [1000, 1000, 1000, 1000],
    envNames: ['CUDA_CACHE_PATH', 'CUDA_MPS_ACTIVE_THREAD_PERCENTAGE', 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT', 'CUDA_MPS_PIPE_DIRECTORY', 'PATH'],
    cuda: { CUDA_MPS_ACTIVE_THREAD_PERCENTAGE: '50', CUDA_MPS_PINNED_DEVICE_MEM_LIMIT: '0=3072M', CUDA_MPS_PIPE_DIRECTORY: '/run/ploinky-mps-pipe', CUDA_CACHE_PATH: '/tmp/cuda-cache' },
    ...overrides,
  };
}

test('runnerIdentity accepts exactly the three MPS keys of the saved share and reports only those values', () => {
  const result = runnerIdentity(runner(), { share: SHARE });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.identity.mps).sort(), ['CUDA_MPS_ACTIVE_THREAD_PERCENTAGE', 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT', 'CUDA_MPS_PIPE_DIRECTORY']);
  assert.equal(result.identity.uid, 1000);
  assert.equal(JSON.stringify(result).includes('/tmp/cuda-cache'), false);
});

test('runnerIdentity rejects each deviation from the exact environment', () => {
  const problems = (overrides) => runnerIdentity(runner(overrides), { share: SHARE }).problems.join(' | ');
  assert.match(problems({ cuda: { CUDA_MPS_ACTIVE_THREAD_PERCENTAGE: '50', CUDA_MPS_PINNED_DEVICE_MEM_LIMIT: '0=3072M' } }), /not exactly the three MPS variables/);
  assert.match(problems({ cuda: { ...runner().cuda, CUDA_VISIBLE_DEVICES: '0' } }), /not exactly the three MPS variables/);
  assert.match(problems({ cuda: { ...runner().cuda, CUDA_MPS_ACTIVE_THREAD_PERCENTAGE: '51' } }), /not the saved share 50% \/ 0=3072M/);
  assert.match(problems({ cuda: { ...runner().cuda, CUDA_MPS_PINNED_DEVICE_MEM_LIMIT: '0=3071M' } }), /not the saved share/);
  assert.match(problems({ cuda: { ...runner().cuda, CUDA_MPS_PIPE_DIRECTORY: '/tmp/pipe' } }), /not the saved share/);
  assert.match(problems({ cuda: { ...runner().cuda, CUDA_CACHE_PATH: '/data/cache' } }), /CUDA cache outside/);
  assert.match(problems({ envNames: ['HF_TOKEN', 'PATH'] }), /secret-looking variables: HF_TOKEN/);
  assert.match(problems({ uid: [0, 0, 0, 0] }), /non-root user/);
  assert.match(problems({ uid: [1000, 0, 1000, 1000] }), /non-root user/);
  assert.match(problems({ uid: [] }), /non-root user/);
});

// ---------------------------------------------------------------------------
// GPU inventory parsing

test('parseGpuInventory reads an idle device, a display row and an MPS server row', () => {
  assert.deepEqual(parseGpuInventory(gpuXml(), UUID).details, []);
  const rows = parseGpuInventory(gpuXml({ processes: [{ pid: 2899, type: 'G', name: 'gnome-shell', memory: 2 }, { pid: 77, type: 'M+C', name: 'nvidia-cuda-mps-server', memory: 30 }] }), UUID);
  assert.deepEqual(rows.processes, [{ pid: 2899, type: 'G' }, { pid: 77, type: 'M+C' }]);
  assert.equal(rows.details[0].memoryMiB, 2);
  assert.equal(parseGpuInventory(gpuXml({ processes: [{ pid: 5, type: 'C', name: 'x' }] }), UUID).details[0].memoryMiB, null);
  assert.deepEqual(parseGpuMemory(gpuXml({ total: 6144, used: 100 })), { totalMiB: 6144, usedMiB: 100, freeMiB: 6044 });
  assert.equal(parseGpuUtilization(gpuXml()), 7);
});

test('parseGpuInventory fails closed on every unsupported or ambiguous reply', () => {
  assert.throws(() => parseGpuInventory(gpuXml({ uuid: 'GPU-11111111-2222' }), UUID), /mismatch/);
  assert.throws(() => parseGpuInventory(gpuXml({ mode: 'Exclusive_Process' }), UUID), /mismatch/);
  assert.throws(() => parseGpuInventory(gpuXml({ processesSection: false }), UUID), /activity inventory unavailable/);
  assert.throws(() => parseGpuInventory(gpuXml().replace('<processes></processes>', '<processes>N/A</processes>'), UUID), /unavailable/);
  assert.throws(() => parseGpuInventory(gpuXml().replace('<processes></processes>', '<processes>Not Supported</processes>'), UUID), /unavailable/);
  assert.throws(() => parseGpuInventory(gpuXml().replace('<processes></processes>', '<processes></processes><processes></processes>'), UUID), /Ambiguous/);
  assert.throws(() => parseGpuInventory(gpuXml({ processes: [{ pid: 5, type: 'X', name: 'x' }] }), UUID), /Malformed/);
  assert.throws(() => parseGpuInventory(gpuXml({ processes: [{ pid: 'abc', type: 'C', name: 'x' }] }), UUID), /Malformed/);
  assert.throws(() => parseGpuInventory('<nvidia_smi_log><gpu id="1"></gpu>', UUID), /Unsupported GPU inventory/);
  assert.throws(() => parseGpuInventory(gpuXml({ extra: '<!ENTITY x "y">' }), UUID), /Unsupported GPU inventory/);
  assert.throws(() => parseGpuMemory('<fb_memory_usage></fb_memory_usage>'), /Unsupported GPU memory/);
  assert.equal(parseGpuUtilization('nothing'), null);
});

// ---------------------------------------------------------------------------
// A5 idle gate

const DISPLAY = { pid: 2899, type: 'G', name: 'gnome-shell', memory: 2 };
const world = () => hostWorld({
  2899: { startIdentity: '111', cgroup: '/user.slice/gdm.scope' },
  7001: { startIdentity: '222', cgroup: `${BOX_PREFIX}/ploinky/core`, nspid: [7001, 55] },
  8001: { startIdentity: '333', cgroup: '/user.slice/other-user.scope' },
});
const gateOver = (xml, host = world()) => createIdleGate({ query: async () => xml.value ?? xml, uuid: UUID, observer: host, boxPrefix: BOX_PREFIX });

test('the A5 gate passes an idle GPU and records nothing', async () => {
  const gate = gateOver(gpuXml());
  const baseline = await gate.initial();
  assert.deepEqual(baseline.tolerated, []);
  const checkedGpu = await gate.check('later');
  assert.deepEqual(checkedGpu.inventory.processes, []);
});

test('the A5 gate tolerates ONE recorded display process of type G up to 64 MiB, and every later check re-proves it', async () => {
  const query = { value: gpuXml({ processes: [DISPLAY] }) };
  const gate = createIdleGate({ query: async () => query.value, uuid: UUID, observer: world(), boxPrefix: BOX_PREFIX });
  const baseline = await gate.initial();
  assert.equal(baseline.tolerated.length, 1);
  assert.deepEqual({ hostPid: baseline.tolerated[0].hostPid, type: baseline.tolerated[0].type, memoryMiB: baseline.tolerated[0].memoryMiB }, { hostPid: 2899, type: 'G', memoryMiB: 2 });
  assert.equal((await gate.check('again')).tolerated.length, 1);
  query.value = gpuXml();
  const gone = await gate.check('vanished');
  assert.deepEqual(gone.vanished, [2899]);
});

test('the A5 gate blocks every case the rule does not allow, and a tripped gate never passes again', async () => {
  const blockedWith = async (xml, host) => {
    const gate = gateOver(xml, host);
    await assert.rejects(() => gate.initial(), (error) => error instanceof EvidenceBlocked && /gpu_busy/.test(error.message));
    await assert.rejects(() => gate.check('after'), EvidenceBlocked);
    return gate.tripped.detail;
  };
  assert.equal((await blockedWith(gpuXml({ processes: [{ ...DISPLAY, type: 'C' }] }))).why, 'not_tolerable');
  assert.equal((await blockedWith(gpuXml({ processes: [{ ...DISPLAY, type: 'C+G' }] }))).why, 'not_tolerable');
  assert.equal((await blockedWith(gpuXml({ processes: [{ ...DISPLAY, memory: A5_TOLERATED_MAX_MIB + 1 }] }))).why, 'not_tolerable');
  assert.equal((await blockedWith(gpuXml({ processes: [{ ...DISPLAY, memory: undefined }] }))).why, 'not_tolerable');
  assert.equal((await blockedWith(gpuXml({ processes: [DISPLAY, { pid: 8001, type: 'G', name: 'second', memory: 1 }] }))).why, 'too_many');
  assert.equal((await blockedWith(gpuXml({ processes: [{ pid: 8001, type: 'C', name: 'train', memory: 900 }] }))).why, 'not_tolerable');
});

test('the A5 gate blocks a display process whose identity is not proven, whose type gains compute, or that grows', async () => {
  await assert.rejects(() => gateOver(gpuXml({ processes: [DISPLAY] }), hostWorld({})).initial(), (error) => error.detail.reason === 'display_identity_unproved');
  for (const [mutate, why] of [
    [(row) => ({ ...row, type: 'C+G' }), 'type_changed'],
    [(row) => ({ ...row, memory: 65 }), 'memory_over_limit'],
  ]) {
    const query = { value: gpuXml({ processes: [DISPLAY] }) };
    const gate = createIdleGate({ query: async () => query.value, uuid: UUID, observer: world(), boxPrefix: BOX_PREFIX });
    await gate.initial();
    query.value = gpuXml({ processes: [mutate(DISPLAY)] });
    await assert.rejects(() => gate.check('changed'), (error) => error.detail.why === why);
  }
  const query = { value: gpuXml({ processes: [DISPLAY] }) };
  const entries = { 2899: { startIdentity: '111', cgroup: '/user.slice/gdm.scope' } };
  const host = hostWorld(entries);
  const gate = createIdleGate({ query: async () => query.value, uuid: UUID, observer: host, boxPrefix: BOX_PREFIX });
  await gate.initial();
  entries[2899] = { startIdentity: '999', cgroup: '/user.slice/gdm.scope' };
  await assert.rejects(() => gate.check('reused pid'), (error) => error.detail.why === 'identity_changed');
});

test('a foreign process that appears after the first check blocks even when a display process is recorded', async () => {
  const query = { value: gpuXml({ processes: [DISPLAY] }) };
  const gate = createIdleGate({ query: async () => query.value, uuid: UUID, observer: world(), boxPrefix: BOX_PREFIX });
  await gate.initial();
  query.value = gpuXml({ processes: [DISPLAY, { pid: 8001, type: 'C', name: 'train', memory: 10 }] });
  await assert.rejects(() => gate.check('foreign'), (error) => error.detail.why === 'not_recorded' && error.detail.foreign.includes(8001));
  await assert.rejects(() => gate.check('still tripped'), EvidenceBlocked);
});

test('the gate refuses to run before its initial check, on a query failure and on insufficient free memory', async () => {
  const gate = gateOver(gpuXml());
  await assert.rejects(() => gate.check('early'), /before its initial check/);
  const failing = createIdleGate({ query: async () => { throw new Error('nvidia-smi missing'); }, uuid: UUID, observer: world(), boxPrefix: BOX_PREFIX });
  await assert.rejects(() => failing.initial(), (error) => error.detail.reason === 'query_error');
  const garbage = gateOver('not xml');
  await assert.rejects(() => garbage.initial(), (error) => error.detail.reason === 'unsupported_output');
  const wrongMode = gateOver(gpuXml({ mode: 'Prohibited' }));
  await assert.rejects(() => wrongMode.initial(), (error) => error.detail.reason === 'device_or_mode_mismatch');
  const noActivity = gateOver(gpuXml({ processesSection: false }));
  await assert.rejects(() => noActivity.initial(), (error) => error.detail.reason === 'activity_unknown');
  const small = createIdleGate({ query: async () => gpuXml({ total: 6144, used: 6000 }), uuid: UUID, observer: world(), boxPrefix: BOX_PREFIX });
  await small.initial();
  await assert.rejects(() => small.check('big', { minFreeMiB: 3328 }), (error) => error.detail.reason === 'insufficient_free_memory');
});

test('evaluateIdleGate is a pure function: an owned record from another boot is never trusted', () => {
  const inventory = parseGpuInventory(gpuXml({ processes: [{ pid: 7001, type: 'M+C', name: 's', memory: 5 }] }), UUID);
  const host = world();
  const verdict = evaluateIdleGate({ inventory, owned: [{ hostPid: 7001, bootId: 'boot-0', startIdentity: '222' }], observe: host.observe, bootId: host.bootId(), boxCgroupPrefix: BOX_PREFIX });
  assert.equal(verdict.reason, 'owned_provenance_unproved');
});

test('summarizeGpuCheck separates the runner rows and the owned rows', () => {
  const inventory = parseGpuInventory(gpuXml({ processes: [{ pid: 10, type: 'C', name: 'r', memory: 700 }, { pid: 11, type: 'M+C', name: 's', memory: 30 }] }), UUID);
  const row = summarizeGpuCheck('x', { inventory, memory: { usedMiB: 735 }, utilization: 91, owned: [10, 11] }, [10], 5);
  assert.deepEqual({ runnerMiB: row.runnerMiB, ownedMiB: row.ownedMiB, runnerListed: row.runnerListed, ownedListed: row.ownedListed, utilizationPercent: row.utilizationPercent }, { runnerMiB: 700, ownedMiB: 730, runnerListed: 1, ownedListed: 2, utilizationPercent: 91 });
  const unknown = parseGpuInventory(gpuXml({ processes: [{ pid: 10, type: 'C', name: 'r' }] }), UUID);
  assert.equal(summarizeGpuCheck('x', { inventory: unknown, memory: {}, owned: [] }, [10]).runnerMiB, null);
});

// ---------------------------------------------------------------------------
// Host observer and runner mapping

test('createHostObserver reads identity, namespaces and cgroup from /proc and treats a vanished PID as absent', () => {
  const files = {
    '/p/sys/kernel/random/boot_id': 'boot-xyz\n',
    '/p/42/stat': '42 (llama server) S 7 42 42 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 9 0 9001 1 2',
    '/p/42/status': 'Name:\tllama\nUid:\t1000\t1000\t1000\t1000\nNSpid:\t42\t17\t3\n',
    '/p/42/cgroup': `0::/user.slice/box.scope/ploinky/agents/libpod-${ID_A}.scope\n`,
  };
  const fsApi = {
    readFileSync: (file) => { if (file in files) return files[file]; const error = new Error('gone'); error.code = 'ENOENT'; throw error; },
    readdirSync: () => ['42', 'self', '1x', '7'],
  };
  const observer = createHostObserver({ fsApi, procRoot: '/p' });
  assert.equal(observer.bootId(), 'boot-xyz');
  assert.deepEqual(observer.observe(42), { hostPid: 42, bootId: 'boot-xyz', startIdentity: '9001', ppid: 7, cgroup: `/user.slice/box.scope/ploinky/agents/libpod-${ID_A}.scope`, comm: '', uid: [1000, 1000, 1000, 1000], nspid: [42, 17, 3] });
  assert.equal(observer.observe(99), null);
  assert.deepEqual(observer.scan(), [42, 7]);
  assert.throws(() => observer.observe(0), /Invalid host PID/);
});

test('hostRunnerIdentities maps an in-agent runner to exactly one host process of that container', () => {
  const host = hostWorld({
    900: { startIdentity: '9001', cgroup: `${BOX_PREFIX}/ploinky/agents/libpod-${ID_A}.scope`, nspid: [900, 120, 42] },
    901: { startIdentity: '9001', cgroup: `${BOX_PREFIX}/ploinky/agents/libpod-${ID_B}.scope`, nspid: [901, 121, 42] },
    902: { startIdentity: '9002', cgroup: `${BOX_PREFIX}/ploinky/agents/libpod-${ID_A}.scope`, nspid: [902, 122, 42] },
  });
  const [mapped] = hostRunnerIdentities({ inner: [{ pid: 42, start: '9001' }], containerId: ID_A, observer: host });
  assert.deepEqual(mapped, { hostPid: 900, bootId: 'boot-1', startIdentity: '9001', innerPid: 42 });
  assert.throws(() => hostRunnerIdentities({ inner: [{ pid: 43, start: '9001' }], containerId: ID_A, observer: host }), /exactly one host process of the agent's cgroup \(0\)/);
  assert.throws(() => hostRunnerIdentities({ inner: [{ pid: 42, start: '9001' }], containerId: 'short', observer: host }), /Invalid agent container identity/);
  const twin = hostWorld({
    900: { startIdentity: '9001', cgroup: `${BOX_PREFIX}/ploinky/agents/libpod-${ID_A}.scope`, nspid: [900, 120, 42] },
    903: { startIdentity: '9001', cgroup: `${BOX_PREFIX}/ploinky/agents/libpod-${ID_A}.scope`, nspid: [903, 123, 42] },
  });
  assert.throws(() => hostRunnerIdentities({ inner: [{ pid: 42, start: '9001' }], containerId: ID_A, observer: twin }), /\(2\)/);
});

// ---------------------------------------------------------------------------
// The delayed-read regression (M-LLM-06): an observation counts as in flight only when its whole read lies inside ONE
// request window. Reads of 40 ms against requests of 8 ms are never in flight.

test('classifyObservation labels each observation against its own request window', () => {
  const window = { sent: 100, settled: 108 };
  assert.equal(classifyObservation({ startedAt: 101, endedAt: 105 }, [window]), 'in-flight');
  assert.equal(classifyObservation({ startedAt: 100, endedAt: 108 }, [window]), 'late');
  assert.equal(classifyObservation({ startedAt: 101, endedAt: 141 }, [window]), 'late');
  assert.equal(classifyObservation({ startedAt: 90, endedAt: 104 }, [window]), 'late');
  assert.equal(classifyObservation({ startedAt: 200, endedAt: 210 }, [window]), 'between-requests');
  assert.equal(classifyObservation({ startedAt: 101, endedAt: 105 }, [{ sent: 100, settled: null }]), 'late');
  // A request that starts later does not vouch for an earlier request's late sample.
  assert.equal(classifyObservation({ startedAt: 101, endedAt: 141 }, [window, { sent: 110, settled: 150 }]), 'late');
  // A read spanning two requests is late, not in flight.
  assert.equal(classifyObservation({ startedAt: 104, endedAt: 112 }, [window, { sent: 110, settled: 150 }]), 'late');
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function samplers({ readMs, requestMs }) {
  return {
    request: async () => { await sleep(requestMs); return { text: 'a numbered list', completionTokens: 5 }; },
    sampleLeaf: async () => { await sleep(readMs); return { usageUsec: 1, atUs: 1, cpuMax: '400000 100000' }; },
    sampleGpu: async () => { await sleep(readMs); return { runnerMiB: 700, ownedMiB: 730, usedMiB: 735, utilizationPercent: 50 }; },
  };
}

test('delayed reads (40 ms) against short requests (8 ms) never reach the in-flight minimums', async () => {
  const result = await measureInference({ ...samplers({ readMs: 40, requestMs: 8 }), sampleMs: 2, gpuMs: 2, sustainedMs: 400, maxRequests: 4 });
  assert.equal(result.failure, null);
  const counts = inFlightCounts(result.cgroup, result.gpu);
  assert.deepEqual(counts, { cgroup: 0, gpu: 0 });
  assert.equal(meetsInFlightMinimums(result.cgroup, result.gpu), false);
  assert.notEqual(result.load.stoppedBy, 'minimums-met');
  const kept = [...result.cgroup, ...result.gpu].filter((sample) => sample.label === 'pending' || sample.label === 'in-flight');
  assert.deepEqual(kept, [], 'no sample may keep a pending or in-flight label');
  assert.ok([...result.cgroup, ...result.gpu].some((sample) => sample.label === 'late'), 'late observations stay as evidence');
});

test('a genuinely in-flight control reaches both minimums and stops on them', async () => {
  const result = await measureInference({ ...samplers({ readMs: 15, requestMs: 400 }), sampleMs: 5, gpuMs: 5, sustainedMs: 5000, maxRequests: 4 });
  assert.equal(result.failure, null);
  const counts = inFlightCounts(result.cgroup, result.gpu);
  assert.ok(counts.cgroup >= INFERENCE_MIN_IN_FLIGHT.cgroup, `in-flight CPU/RAM samples ${counts.cgroup}`);
  assert.ok(counts.gpu >= INFERENCE_MIN_IN_FLIGHT.gpu, `in-flight GPU samples ${counts.gpu}`);
  assert.equal(meetsInFlightMinimums(result.cgroup, result.gpu), true);
  assert.equal(result.load.stoppedBy, 'minimums-met');
  assert.equal(result.windows.length, result.load.requests);
  assert.ok(result.windows.every((window) => window.settled !== null && window.settled >= window.sent));
  assert.equal(result.kept.text, 'a numbered list');
});

test('the same check applies to GPU rows: slow GPU reads never count even when CPU reads are fast', async () => {
  const fast = samplers({ readMs: 5, requestMs: 100 });
  const result = await measureInference({ ...fast, sampleGpu: async () => { await sleep(120); return { runnerMiB: 1, ownedMiB: 1, usedMiB: 1, utilizationPercent: 1 }; }, sampleMs: 5, gpuMs: 5, sustainedMs: 600, maxRequests: 3 });
  const counts = inFlightCounts(result.cgroup, result.gpu);
  assert.equal(counts.gpu, 0);
  assert.ok(counts.cgroup >= 1);
  assert.equal(meetsInFlightMinimums(result.cgroup, result.gpu), false);
});

test('the regression detects the defect: a classifier that decides at read start would count the delayed reads', async () => {
  const startOnly = (sample, windows) => (windows.some((window) => sample.startedAt >= window.sent && (window.settled === null || sample.startedAt < window.settled)) ? 'in-flight' : 'between-requests');
  const result = await measureInference({ ...samplers({ readMs: 40, requestMs: 8 }), classify: startOnly, sampleMs: 2, gpuMs: 2, sustainedMs: 400, maxRequests: 4 });
  assert.ok(inFlightCounts(result.cgroup, result.gpu).cgroup > 0, 'the defective classifier must count at least one late read, otherwise the regression proves nothing');
});

test('a later response without text is recorded, and a failing request is reported with its evidence kept', async () => {
  let calls = 0;
  const base = samplers({ readMs: 1, requestMs: 30 });
  const replies = [{ text: 'first', completionTokens: 3 }, { text: '  ', completionTokens: 0 }, { text: 'third' }];
  const result = await measureInference({ ...base, request: async () => { await sleep(30); return replies[Math.min(calls++, 2)]; }, sampleMs: 100, gpuMs: 100, sustainedMs: 5000, maxRequests: 3 });
  assert.equal(result.load.requests, 3);
  assert.equal(result.load.stoppedBy, 'request-bound');
  assert.equal(result.load.invalidResponses, 1);
  assert.equal(result.kept.text, 'first');
  const failed = await measureInference({ ...base, request: async () => { await sleep(10); throw new Error('model gone'); }, sampleMs: 2, gpuMs: 2, sustainedMs: 100, maxRequests: 2 });
  assert.match(String(failed.failure?.message), /model gone/);
  assert.ok(failed.cgroup.length >= 1, 'the samples taken before the failure remain evidence');
});

// ---------------------------------------------------------------------------
// The deployed analysis

function deployedModule(overrides = {}) {
  return { classifyObservation, analyzeInference: () => ({ violations: [], blockers: [], summary: {} }), INFERENCE_MIN_IN_FLIGHT, ...overrides };
}
function cloneWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-clone-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

test('loadDeployedAnalysis loads the clone module, checks the minimums and the delayed-read vectors', async () => {
  const root = cloneWith({ 'tests/hardware-limits/liveLlmCommands.mjs': '// stub\n' });
  try {
    const loaded = await loadDeployedAnalysis({ ploinkyRoot: root, importModule: async () => deployedModule() });
    assert.equal(typeof loaded.analyzeInference, 'function');
    assert.equal(loaded.file, path.join(root, 'tests/hardware-limits/liveLlmCommands.mjs'));
    await assert.rejects(() => loadDeployedAnalysis({ ploinkyRoot: root, importModule: async () => deployedModule({ INFERENCE_MIN_IN_FLIGHT: { cgroup: 1, gpu: 1 } }) }), /in-flight minimums differ/);
    await assert.rejects(() => loadDeployedAnalysis({ ploinkyRoot: root, importModule: async () => deployedModule({ classifyObservation: () => 'in-flight' }) }), /must be "late"/);
    await assert.rejects(() => loadDeployedAnalysis({ ploinkyRoot: root, importModule: async () => deployedModule({ analyzeInference: undefined }) }), /does not export analyzeInference/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadDeployedAnalysis fails closed when the clone, its module or its path is missing or unsafe', async () => {
  await assert.rejects(() => loadDeployedAnalysis({ ploinkyRoot: 'relative/clone' }), /absolute/);
  const missing = cloneWith({ 'other.txt': 'x' });
  const linked = cloneWith({ 'real.mjs': '// real\n' });
  try {
    await assert.rejects(() => loadDeployedAnalysis({ ploinkyRoot: missing, importModule: async () => deployedModule() }), /has no .*liveLlmCommands\.mjs/);
    fs.mkdirSync(path.join(linked, 'tests/hardware-limits'), { recursive: true });
    fs.symlinkSync(path.join(linked, 'real.mjs'), path.join(linked, 'tests/hardware-limits/liveLlmCommands.mjs'));
    await assert.rejects(() => loadDeployedAnalysis({ ploinkyRoot: linked, importModule: async () => deployedModule() }), /one regular file/);
  } finally {
    fs.rmSync(missing, { recursive: true, force: true });
    fs.rmSync(linked, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Evidence output

test('sanitizeEvidence removes cookies, CSRF values, environments and credentials but keeps policy tokens and numbers', () => {
  const clean = sanitizeEvidence({
    token: { epoch: 'e1', revision: 4 },
    cookie: 'ploinky_jwt=eyJabcdefghijk.lmnopqrstuvw.xyz',
    headers: { 'x-ploinky-csrf-token': 'abc', authorization: 'Bearer zzz' },
    Env: ['SECRET=1'],
    nested: { password: 'p', csrfToken: 'c', text: 'x-ploinky-browser-csrf-token: abc', ok: 'fine', n: 3 },
    list: [{ session: 's' }, 'plain'],
  });
  assert.deepEqual(clean.token, { epoch: 'e1', revision: 4 });
  assert.equal(clean.cookie, '[redacted]');
  assert.deepEqual(clean.headers, { 'x-ploinky-csrf-token': '[redacted]', authorization: '[redacted]' });
  assert.equal(clean.Env, '[redacted]');
  assert.deepEqual(clean.nested, { password: '[redacted]', csrfToken: '[redacted]', text: '[redacted]', ok: 'fine', n: 3 });
  assert.deepEqual(clean.list, [{ session: '[redacted]' }, 'plain']);
  assert.throws(() => assertNoCredentials('ploinky_jwt=abc'), /cookie, CSRF value or token/);
  assert.doesNotThrow(() => assertNoCredentials('cpu.max 400000 100000'));
});

test('createEvidenceWriter writes sanitized private files and rejects unsafe names and relative directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-evidence-'));
  try {
    const writer = createEvidenceWriter({ dir: path.join(dir, 'hwl') });
    const target = writer.write('readback.json', { cpuMax: '400000 100000', cookie: 'ploinky_jwt=abc', note: 'x-ploinky-csrf-token abc' });
    const stored = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.deepEqual(stored, { cpuMax: '400000 100000', cookie: '[redacted]', note: '[redacted]' });
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    for (const bad of ['../x.json', 'a/b.json', '', 'x'.repeat(81)]) assert.throws(() => writer.write(bad, {}), /Invalid evidence file name/);
    assert.throws(() => createEvidenceWriter({ dir: 'relative' }), /absolute/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Environment, API client and snapshot readers

test('requireHardwareEnvironment fails closed on each missing documented variable', () => {
  const good = { SMOKE_DEPLOYMENT_MODE: 'box', SMOKE_BASE_URL: 'http://localhost:18080', SMOKE_PLOINKY_BOX_CONTAINER: BOX };
  assert.deepEqual(requireHardwareEnvironment(good), { boxName: BOX });
  for (const name of Object.keys(good)) {
    const env = { ...good };
    delete env[name];
    assert.throws(() => requireHardwareEnvironment(env), new RegExp(name), `${name} must be required`);
  }
  assert.throws(() => requireHardwareEnvironment({ ...good, SMOKE_DEPLOYMENT_MODE: 'local' }), /SMOKE_DEPLOYMENT_MODE must be "box"/);
  assert.throws(() => requireHardwareEnvironment({ ...good, SMOKE_PLOINKY_BOX_CONTAINER: 'a b' }), /SMOKE_PLOINKY_BOX_CONTAINER/);
});

const PROOF_PAYLOAD = { ok: true, adminControl: { origin: 'http://localhost:18080', csrfToken: 'csrf-secret-value-1234' } };

function fakeRequest({ gets = {}, posts = [] } = {}) {
  const log = [];
  const respond = (status, body) => ({ status: () => status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  return {
    log,
    get: async (url, options) => { log.push({ method: 'GET', url, options }); const answer = gets[url] ?? [200, {}]; return respond(...answer); },
    post: async (url, options) => { log.push({ method: 'POST', url, options }); const answer = posts.shift() ?? [200, { ok: true }]; return respond(...answer); },
  };
}

test('parseProof accepts the administrator and browser proofs and refuses anything partial', () => {
  assert.deepEqual(parseProof(PROOF_PAYLOAD), { origin: 'http://localhost:18080', csrfToken: 'csrf-secret-value-1234', header: 'x-ploinky-csrf-token' });
  assert.equal(parseProof({ ok: true, browserMutation: { origin: 'o', csrfToken: 'c' } }).header, 'x-ploinky-browser-csrf-token');
  assert.throws(() => parseProof({ ok: true, adminControl: { origin: 'o' } }), /no administrator mutation proof/);
  assert.throws(() => parseProof({ ok: false, adminControl: { origin: 'o', csrfToken: 'c' } }), /no administrator mutation proof/);
  assert.throws(() => parseProof({}), /no administrator mutation proof/);
});

test('the hardware API sends the proof and the exact Origin on POST, none on GET, and never returns the proof', async () => {
  const request = fakeRequest({ gets: { '/auth/token': [200, PROOF_PAYLOAD], '/api/marketplace/hardware-limits': [200, { ok: true, token: { epoch: 'e', revision: 1 } }] }, posts: [[200, { ok: true, committed: true }], [403, { ok: false, error: 'origin_invalid' }], [400, 'not json']] });
  const api = createHardwareApi({ request });
  const snapshot = await api.readOk();
  assert.equal(snapshot.ok, true);
  const get = request.log.at(-1);
  assert.equal(get.url, '/api/marketplace/hardware-limits');
  assert.equal(Object.keys(get.options.headers).some((name) => /csrf|origin|authorization/i.test(name)), false);
  const posted = await api.post({ action: 'apply', expectedToken: { epoch: 'e', revision: 1 }, containers: [] });
  assert.deepEqual(posted, { status: 200, body: { ok: true, committed: true } });
  const post = request.log.filter((entry) => entry.method === 'POST')[0];
  assert.equal(post.options.headers.origin, 'http://localhost:18080');
  assert.equal(post.options.headers['x-ploinky-csrf-token'], 'csrf-secret-value-1234');
  assert.equal(JSON.parse(post.options.data).action, 'apply');
  const wrong = await api.post({ action: 'apply' }, { origin: 'https://evil.example' });
  assert.equal(wrong.status, 403);
  assert.equal(request.log.filter((entry) => entry.method === 'POST')[1].options.headers.origin, 'https://evil.example');
  const raw = await api.post(null, { rawBody: '{"action":', headers: { 'x-extra': '1' } });
  assert.deepEqual(raw, { status: 400, body: { raw: 'not json' } });
  const rawCall = request.log.filter((entry) => entry.method === 'POST')[2];
  assert.equal(rawCall.options.data, '{"action":');
  assert.equal(rawCall.options.headers['x-extra'], '1');
  for (const result of [posted, wrong, raw, snapshot]) assert.equal(JSON.stringify(result).includes('csrf-secret-value-1234'), false);
  const bearer = await api.read({ headers: { authorization: 'Bearer not-a-real-token' } });
  assert.equal(request.log.at(-1).options.headers.authorization, 'Bearer not-a-real-token');
  assert.equal(bearer.status, 200);
});

test('the hardware API refuses a session without proof and a snapshot that is not 200 ok', async () => {
  const noProof = createHardwareApi({ request: fakeRequest({ gets: { '/auth/token': [401, { ok: false }] } }) });
  await assert.rejects(() => noProof.post({ action: 'apply' }), /proof request answered 401/);
  const denied = createHardwareApi({ request: fakeRequest({ gets: { '/api/marketplace/hardware-limits': [403, { ok: false, error: 'admin_required' }] } }) });
  await assert.rejects(() => denied.readOk(), /answered 403 \(admin_required\)/);
  assert.throws(() => createHardwareApi({ request: {} }), /needs an API request context/);
});

test('snapshot readers find tokens, agents, instances and the single ready target', () => {
  const snapshot = {
    token: { epoch: 'e1', revision: 7 },
    agents: [
      { ref: 'AchillesIDE/tasksAgent', containers: [{ key: 'k1', availability: 'ready' }] },
      { ref: 'AchillesIDE/gitAgent', containers: [{ key: 'k2', availability: 'ready' }, { key: 'k3', alias: 'x', availability: 'ready' }] },
      { ref: 'AchillesIDE/stopped', containers: [{ key: 'k4', availability: 'stopped' }] },
      { ref: 'nosuch/orphan', orphaned: true, containers: [] },
    ],
  };
  assert.deepEqual(tokenOf(snapshot), { epoch: 'e1', revision: 7 });
  assert.throws(() => tokenOf({}), /no policy token/);
  assert.equal(sameToken({ epoch: 'e1', revision: 7 }, tokenOf(snapshot)), true);
  assert.equal(sameToken({ epoch: 'e1', revision: 8 }, tokenOf(snapshot)), false);
  assert.equal(sameToken(null, tokenOf(snapshot)), false);
  assert.equal(agentByRef(snapshot, 'AchillesIDE/gitAgent').containers.length, 2);
  assert.equal(agentByRef(snapshot, 'nope/x'), null);
  assert.equal(instanceByKey(snapshot, 'k3').agent.ref, 'AchillesIDE/gitAgent');
  assert.equal(instanceByKey(snapshot, 'zzz'), null);
  assert.equal(findSingleInstanceAgent(snapshot, 'tasksAgent').instance.key, 'k1');
  assert.throws(() => findSingleInstanceAgent(snapshot, 'gitAgent'), /exactly one ready instance/);
  assert.throws(() => findSingleInstanceAgent(snapshot, 'stopped'), /exactly one ready instance \(it has stopped\)/);
  assert.throws(() => findSingleInstanceAgent(snapshot, 'absent'), /found 0/);
  assert.throws(() => findSingleInstanceAgent(snapshot, 'orphan'), /found 0/);
});

test('waitFor returns the first truthy value and times out with its label', async () => {
  let calls = 0;
  assert.equal(await waitFor(async () => (++calls >= 3 ? 'done' : null), { timeoutMs: 1000, intervalMs: 1 }), 'done');
  assert.equal(calls, 3);
  await assert.rejects(() => waitFor(async () => null, { timeoutMs: 20, intervalMs: 5, label: 'the snapshot' }), /Timed out after 20 ms waiting for the snapshot/);
});

// ---------------------------------------------------------------------------
// Owned processes beneath the exact Box, refusal codes, share arithmetic and runner reads

test('a listed process that vanishes between the query and the host read is read again, not judged foreign', async () => {
  const entries = {};
  let reads = 0;
  const query = async () => {
    reads += 1;
    if (reads === 1) return gpuXml();
    if (reads === 2) { entries[7001] = undefined; return gpuXml({ processes: [{ pid: 7001, type: 'M+C', name: 'nvidia-cuda-mps-server', memory: 30 }] }); }
    return gpuXml();
  };
  const gate = createIdleGate({ query, uuid: UUID, observer: hostWorld(entries), boxPrefix: BOX_PREFIX, sleep: async () => {} });
  await gate.initial();
  const result = await gate.check('vanishing server');
  assert.deepEqual(result.inventory.processes, []);
  assert.equal(reads, 3);
});

test('refusalCode reads the typed code of a JSON refusal or an admission word of the message', () => {
  assert.equal(refusalCode(JSON.stringify({ error: 'admission_insufficient_now', message: 'Needs about 0.8 GiB' })), 'admission_insufficient_now');
  assert.equal(refusalCode('MCP error -32000: admission_insufficient_now: Needs about 0.8 GiB of RAM'), 'admission_insufficient_now');
  assert.equal(refusalCode('MCP error -32000: ' + JSON.stringify({ error: 'admission_insufficient_now', message: 'x' })), 'admission_insufficient_now');
  assert.equal(refusalCode('The tool failed.'), null);
  assert.equal(refusalCode(undefined), null);
});

test('shareMemoryMiB is the whole-MiB share of the physical device', () => {
  assert.equal(shareMemoryMiB(50, 6144), 3072);
  assert.equal(shareMemoryMiB(25, 6144), 1536);
  assert.equal(shareMemoryMiB(8, 6144), 491);
});

test('readRunnerProcesses reads the runner list in the agent through the nested engine only', async () => {
  const calls = [];
  const run = (command, args) => { calls.push(args); return { status: 0, stdout: JSON.stringify({ processes: [runner()] }) }; };
  const processes = await readRunnerProcesses({ run, boxName: BOX, agentName: 'ploinky_local_llm_agent' });
  assert.equal(processes.length, 1);
  assert.deepEqual(calls[0].slice(0, 7), [...coreArgs(BOX), 'podman', '--cgroup-manager=cgroupfs']);
  assert.equal(calls[0].includes('ploinky_local_llm_agent'), true);
  await assert.rejects(() => readRunnerProcesses({ run, boxName: BOX, agentName: 'bad name' }), /Box container name/);
  await assert.rejects(() => readRunnerProcesses({ run: () => ({ status: 0, stdout: '{}' }), boxName: BOX, agentName: 'ploinky_x' }), /no process list/);
});

test('a reply that carries its own exact request window overrides the loop window', async () => {
  const base = samplers({ readMs: 3, requestMs: 150 });
  let declared = null;
  const result = await measureInference({
    ...base,
    request: async () => { await sleep(150); const sent = Date.now() + 10_000; declared = { sent, settled: sent + 50 }; return { text: 'answer', completionTokens: 1, window: declared }; },
    sampleMs: 3,
    gpuMs: 3,
    sustainedMs: 10,
    maxRequests: 1,
  });
  assert.deepEqual({ sent: result.windows[0].sent, settled: result.windows[0].settled }, declared);
  // Every sample was read well before the declared window, so none may count as in flight.
  assert.deepEqual(inFlightCounts(result.cgroup, result.gpu), { cgroup: 0, gpu: 0 });
  assert.ok(result.cgroup.length >= 2);
});

// ---------------------------------------------------------------------------
// Box cgroup ancestry and role-specific ownership (B2). The Box init lives in <scope>/ploinky/core.

const BOX_ID = 'f'.repeat(64);
const REAL_PREFIX = `/user.slice/user-1000.slice/user@1000.service/user.slice/libpod-${BOX_ID}.scope`;
const INIT_CGROUP = `${REAL_PREFIX}/ploinky/core`;

test('boxPrefixFromInit strips /ploinky/core and requires the exact Box identity', async () => {
  const world = (cgroup) => hostWorld({ 555: { startIdentity: '1', cgroup } });
  assert.equal(boxPrefixFromInit({ boxPid: 555, boxId: BOX_ID, observer: world(INIT_CGROUP) }), REAL_PREFIX);
  const withContainerLeaf = `${REAL_PREFIX.replace(`.scope`, '')}/container/ploinky/core`;
  assert.equal(boxPrefixFromInit({ boxPid: 555, boxId: BOX_ID, observer: world(withContainerLeaf) }), withContainerLeaf.replace('/ploinky/core', ''));
  const refuse = (cgroup, pid = 555, id = BOX_ID) => assert.throws(() => boxPrefixFromInit({ boxPid: pid, boxId: id, observer: world(cgroup) }), EvidenceBlocked);
  refuse(REAL_PREFIX);                                              // not in /ploinky/core: the old rule accepted this
  refuse(`${REAL_PREFIX}/ploinky/agents`);                          // wrong suffix
  refuse(INIT_CGROUP.replace(BOX_ID, 'e'.repeat(64)));              // another Box
  refuse('/user.slice/ploinky/core');                               // no Box identity
  refuse(INIT_CGROUP, 0);
  refuse(INIT_CGROUP, 555, 'short');
  assert.throws(() => boxPrefixFromInit({ boxPid: 999, boxId: BOX_ID, observer: world(INIT_CGROUP) }), /not in \/ploinky\/core/);
});

test('boxCgroupPrefix reads the init PID and the exact Box ID from one inspection', async () => {
  const calls = [];
  const host = hostWorld({ 555: { startIdentity: '1', cgroup: INIT_CGROUP } });
  const prefix = await boxCgroupPrefix({ run: (command, args) => { calls.push(args); return { status: 0, stdout: `555 ${BOX_ID}\n` }; }, boxName: BOX, observer: host });
  assert.equal(prefix, REAL_PREFIX);
  assert.equal(calls[0].includes('{{.State.Pid}} {{.Id}}'), true);
  await assert.rejects(() => boxCgroupPrefix({ run: () => ({ status: 0, stdout: `0 ${BOX_ID}\n` }), boxName: BOX, observer: host }), /no host init PID/);
  await assert.rejects(() => boxCgroupPrefix({ run: () => ({ status: 0, stdout: `556 ${BOX_ID}\n` }), boxName: BOX, observer: host }), /not in \/ploinky\/core/);
  await assert.rejects(() => boxCgroupPrefix({ run: () => ({ status: 1, stdout: '', stderr: 'no such container' }), boxName: BOX, observer: host }), /Box inspection failed/);
});

const LEAF_A = `${REAL_PREFIX}/ploinky/agents/libpod-${ID_A}.scope`;
function ownershipWorld() {
  const entries = {
    // Real comm values are truncated to 15 characters: both the daemon and the server read "nvidia-cuda-mps".
    6000: { startIdentity: '10', cgroup: `${REAL_PREFIX}/ploinky/core`, comm: 'nvidia-cuda-mps', nspid: [6000, 321] },
    6001: { startIdentity: '11', cgroup: `${REAL_PREFIX}/ploinky/core`, comm: 'nvidia-cuda-mps', ppid: 6000 },
    6002: { startIdentity: '12', cgroup: LEAF_A, comm: 'llama-server' },
    6003: { startIdentity: '13', cgroup: `${REAL_PREFIX}/ploinky/agents/libpod-${ID_B}.scope`, comm: 'other-agent-cuda' },
    6004: { startIdentity: '14', cgroup: `${REAL_PREFIX}/ploinky/core`, comm: 'stray', ppid: 1 },
    6005: { startIdentity: '15', cgroup: INIT_CGROUP.replace(BOX_ID, 'd'.repeat(64)), comm: 'foreign-box-process' },
    // A decoy that carries the untruncated name but is not the recorded daemon (another PID in the Box, another start time).
    6007: { startIdentity: '17', cgroup: `${REAL_PREFIX}/ploinky/core`, comm: 'nvidia-cuda-mps-control', nspid: [6007, 322] },
    6006: { startIdentity: '16', cgroup: `${REAL_PREFIX}/ploinky/agents/libpod-${ID_B}.scope`, comm: 'child-of-daemon-elsewhere', ppid: 6000 },
  };
  return { entries, host: hostWorld(entries, [LEAF_A]) };
}
const listed = (...pids) => gpuXml({ processes: pids.map((pid) => ({ pid, type: pid === 6001 ? 'M+C' : 'C', name: `p${pid}`, memory: 20 })) });
async function registeredGate(world, query) {
  const gate = createIdleGate({ query: async () => query.value, uuid: UUID, observer: world.host, boxPrefix: REAL_PREFIX, sleep: async () => {} });
  const wanted = query.value;
  query.value = gpuXml();
  await gate.initial();
  query.value = wanted;
  return gate;
}

test('the MPS server of a registered daemon and the processes of a registered leaf are owned', async () => {
  const world = ownershipWorld();
  const query = { value: gpuXml() };
  const gate = await registeredGate(world, query);
  assert.equal(findMpsDaemon({ observer: world.host, boxPrefix: REAL_PREFIX, daemon: { pid: 321, startTime: '10' } }).hostPid, 6000);
  gate.registerDaemon(6000);
  gate.registerLeaf(agentLeafPath({ observer: world.host, boxPrefix: REAL_PREFIX, containerId: ID_A }));
  query.value = listed(6001, 6002);
  assert.deepEqual((await gate.check('inference')).owned.sort(), [6001, 6002]);
});

test('ownership is role-specific: anything else beneath the Box, another Box or a reused daemon PID is foreign', async () => {
  const blocked = async (query, mutate) => {
    const world = ownershipWorld();
    const gate = await registeredGate(world, query);
    gate.registerDaemon(6000);
    gate.registerLeaf(LEAF_A);
    if (mutate) mutate(world);
    return assert.rejects(() => gate.check('probe'), (error) => error.detail.reason === 'gpu_busy' && error.detail.why === 'not_recorded');
  };
  // A process in <Box>/ploinky/core that is not a child of the registered daemon.
  await blocked({ value: listed(6004) });
  // A process of another agent of the same Box: its leaf is not registered.
  await blocked({ value: listed(6003) });
  // A child of the registered daemon that is NOT placed in <Box>/ploinky/core is not its server.
  await blocked({ value: listed(6006) });
  // A process of another Box.
  await blocked({ value: listed(6005) });
  // The daemon PID was reused (another start identity): its former child is no longer the server of a registered daemon.
  await blocked({ value: listed(6001) }, (world) => { world.entries[6000] = { ...world.entries[6000], startIdentity: '99' }; });
  // Unregistered leaf: without registerLeaf the runner row is foreign.
  const world = ownershipWorld();
  const query = { value: gpuXml() };
  const gate = await registeredGate(world, query);
  gate.registerDaemon(6000);
  query.value = listed(6002);
  await assert.rejects(() => gate.check('no leaf'), (error) => error.detail.why === 'not_recorded');
});

test('registration refuses a daemon outside <Box>/ploinky/core and a leaf outside the Box agents hierarchy', async () => {
  const world = ownershipWorld();
  const gate = await registeredGate(world, { value: gpuXml() });
  assert.throws(() => gate.registerDaemon(6002), EvidenceBlocked);
  assert.throws(() => gate.registerDaemon(6005), EvidenceBlocked);
  assert.throws(() => gate.registerDaemon(424242), EvidenceBlocked);
  for (const bad of [REAL_PREFIX, `${REAL_PREFIX}/ploinky/agents`, `${REAL_PREFIX}/ploinky/core`, '/user.slice/elsewhere/ploinky/agents/libpod-x', 'relative']) assert.throws(() => gate.registerLeaf(bad), /beneath the exact Box agents hierarchy/);
  assert.equal(agentLeafPath({ observer: world.host, boxPrefix: REAL_PREFIX, containerId: ID_C }), null);
});

test('regression: the old prefix (the init cgroup itself) classifies the MPS server and the runner as foreign', async () => {
  const query = { value: gpuXml() };
  const old = ownershipWorld();
  // The previous behaviour used the Box init's own cgroup as the Box prefix and `<prefix>/ploinky` as the owned prefix.
  const gate = createIdleGate({ query: async () => query.value, uuid: UUID, observer: old.host, boxPrefix: INIT_CGROUP, sleep: async () => {} });
  await gate.initial();
  assert.throws(() => gate.registerDaemon(6000), EvidenceBlocked);
  query.value = listed(6001, 6002);
  await assert.rejects(() => gate.check('inference'), (error) => error.detail.reason === 'gpu_busy' && error.detail.foreign.includes(6001));
  // With the prefix derived the correct way the same inventory passes.
  const world = ownershipWorld();
  const good = await registeredGate(world, query);
  good.registerDaemon(6000);
  good.registerLeaf(LEAF_A);
  assert.deepEqual((await good.check('inference')).owned.sort(), [6001, 6002]);
});

test('createHostObserver lists a cgroup directory and treats a missing one as absent', () => {
  const fsApi = {
    readFileSync: (file) => {
      if (file === '/c/ploinky/agents/x/cgroup.procs') return '12\n34\n';
      if (file === '/c/ploinky/agents/bad/cgroup.procs') return '12\nabc\n';
      const error = new Error('gone'); error.code = 'ENOENT'; throw error;
    },
    readdirSync: () => [],
  };
  const observer = createHostObserver({ fsApi, cgroupRoot: '/c' });
  assert.deepEqual(observer.cgroupProcs('/ploinky/agents/x'), [12, 34]);
  assert.equal(observer.cgroupProcs('/ploinky/agents/none'), null);
  assert.throws(() => observer.cgroupProcs('/ploinky/agents/bad'), /Unsupported cgroup.procs grammar/);
  assert.throws(() => observer.cgroupProcs('/a/../b'), /Invalid cgroup path/);
});

// ---------------------------------------------------------------------------
// Foreign-workspace guard (N5), runner digest and host GPU identity (N2)

test('requireHardwareEnvironment refuses the cleanup session\'s Box, workspaces and Router port', () => {
  const good = { SMOKE_DEPLOYMENT_MODE: 'box', SMOKE_BASE_URL: 'http://localhost:18080', SMOKE_PLOINKY_BOX_CONTAINER: BOX, SMOKE_WORKSPACE_ROOT: '/home/u/work/hwlReleasePre20261003' };
  const options = { home: '/home/u' };
  assert.deepEqual(requireHardwareEnvironment(good, options), { boxName: BOX });
  assert.throws(() => requireHardwareEnvironment({ ...good, SMOKE_PLOINKY_BOX_CONTAINER: 'ploinky-box-testexplorerfresh-9d2ec627469d' }, options), /cleanup session's Box/);
  assert.throws(() => requireHardwareEnvironment({ ...good, SMOKE_BASE_URL: 'http://127.0.0.1:8080' }, options), /port 8080/);
  assert.throws(() => requireHardwareEnvironment({ ...good, SMOKE_BASE_URL: 'not a url' }, options), /must be a URL/);
  for (const workspace of ['/home/u/work/testExplorerFresh', '/home/u/work/testExplorerFresh/sub/dir', '/home/u/cleanup-repair-claude-20261002', '/home/u/cleanup-repair-claude-20261002/x/../y', '/home/u/work/testExplorerFresh/']) {
    assert.throws(() => requireHardwareEnvironment({ ...good, SMOKE_WORKSPACE_ROOT: workspace }, options), /foreign-workspace guard/, workspace);
  }
  // Siblings that merely share a prefix are not foreign; an unset workspace is allowed for specs that do not use one.
  assert.doesNotThrow(() => requireHardwareEnvironment({ ...good, SMOKE_WORKSPACE_ROOT: '/home/u/work/testExplorerFresh2' }, options));
  assert.doesNotThrow(() => requireHardwareEnvironment({ ...good, SMOKE_WORKSPACE_ROOT: '' }, options));
  assert.throws(() => requireHardwareEnvironment({ ...good, SMOKE_BASE_URL: 'http://localhost:8080', SMOKE_PLOINKY_BOX_CONTAINER: 'ploinky-box-testexplorerfresh-1' }, options), (error) => /port 8080/.test(error.message) && /cleanup session's Box/.test(error.message));
});

test('readRunnerDigest records the runner executable digest and fails when it is absent', async () => {
  const digest = 'a'.repeat(64);
  const ok = await readRunnerDigest({ run: () => ({ status: 0, stdout: JSON.stringify({ file: '/opt/llama.cpp/llama-server', sha256: digest, size: 1234 }) }), boxName: BOX, agentName: 'ploinky_llm' });
  assert.deepEqual(ok, { file: '/opt/llama.cpp/llama-server', sha256: digest, size: 1234 });
  await assert.rejects(() => readRunnerDigest({ run: () => ({ status: 0, stdout: JSON.stringify({ file: '/opt/llama.cpp/llama-server', sha256: null, size: null, error: 'ENOENT' }) }), boxName: BOX, agentName: 'ploinky_llm' }), /no readable \/opt\/llama.cpp\/llama-server/);
  for (const sha256 of [null, 'abc', 'G'.repeat(64)]) {
    await assert.rejects(() => readRunnerDigest({ run: () => ({ status: 0, stdout: JSON.stringify({ file: '/opt/llama.cpp/llama-server', sha256, size: 10 }) }), boxName: BOX, agentName: 'ploinky_llm' }), EvidenceBlocked);
  }
  await assert.rejects(() => readRunnerDigest({ run: () => ({ status: 0, stdout: JSON.stringify({ file: '/other', sha256: digest, size: 1 }) }), boxName: BOX, agentName: 'ploinky_llm' }), EvidenceBlocked);
});

test('readHostGpuIdentity returns exactly the selected device and a driver version', async () => {
  assert.deepEqual(await readHostGpuIdentity({ run: () => ({ status: 0, stdout: `${UUID}, 595.91.07\n` }), uuid: UUID }), { uuid: UUID, driverVersion: '595.91.07' });
  await assert.rejects(() => readHostGpuIdentity({ run: () => ({ status: 0, stdout: 'GPU-11111111-2222, 595.91.07\n' }), uuid: UUID }), EvidenceBlocked);
  await assert.rejects(() => readHostGpuIdentity({ run: () => ({ status: 0, stdout: `${UUID}, 595.91.07\n${UUID}, 595.91.07\n` }), uuid: UUID }), EvidenceBlocked);
  await assert.rejects(() => readHostGpuIdentity({ run: () => ({ status: 0, stdout: `${UUID}, N/A\n` }), uuid: UUID }), EvidenceBlocked);
  await assert.rejects(() => readHostGpuIdentity({ run: () => ({ status: 9, stdout: '', stderr: 'no driver' }), uuid: UUID }), /Host GPU identity query failed/);
});

// ---------------------------------------------------------------------------
// Fixture removal (B1): every run is awaited, instances are disabled by exact key, a failure stops the sequence.

function fixtureSnapshot() {
  return { agents: [
    { ref: 'hwlFixture/static', containers: [{ key: 'ploinky_static_1' }] },
    { ref: 'hwlFixture/aliased', containers: [{ key: 'ploinky_aliased_canonical', alias: null }, { key: 'ploinky_aliased_second', alias: 'second' }] },
    { ref: 'hwlFixture/refused', containers: [{ key: 'ploinky_refused_1' }] },
    { ref: 'hwlFixture/dependant', containers: [{ key: 'ploinky_dependant_1' }] },
    { ref: 'AchillesIDE/tasksAgent', containers: [{ key: 'ploinky_tasks_1' }] },
  ] };
}
const ORDER = ['hwlFixture/static', 'hwlFixture/dependant', 'hwlFixture/refused', 'hwlFixture/aliased'];

test('removeFixture awaits every command and disables each fixture instance by its exact key, then the repository', async () => {
  const log = [];
  // A fake whose answer arrives later: a caller that does not await reads `status` of a Promise.
  const run = (command, args, options) => new Promise((resolve) => setTimeout(() => { log.push({ command, args, cwd: options.cwd }); resolve({ status: 0, stdout: '', stderr: '' }); }, 5));
  const result = await removeFixture({ run, bin: '/opt/ploinky/bin/ploinky', cwd: '/home/u/work/hwlReleasePre20261003', repo: 'hwlFixture', order: ORDER, readSnapshot: async () => fixtureSnapshot() });
  assert.deepEqual(log.map((entry) => entry.args), [
    ['disable', 'agent', 'ploinky_static_1'],
    ['disable', 'agent', 'ploinky_dependant_1'],
    ['disable', 'agent', 'ploinky_refused_1'],
    ['disable', 'agent', 'ploinky_aliased_canonical'],
    ['disable', 'agent', 'ploinky_aliased_second'],
    ['disable', 'repo', 'hwlFixture'],
  ]);
  assert.ok(log.every((entry) => entry.command === '/opt/ploinky/bin/ploinky' && entry.cwd === '/home/u/work/hwlReleasePre20261003'));
  assert.equal(result.commands.length, 6);
  assert.ok(result.commands.every((command) => command.status === 0));
  assert.equal(log.some((entry) => entry.args.includes('second') || entry.args.includes('tasks')), false, 'no bare alias and no non-fixture target');
  assert.equal(JSON.stringify(log).includes('tasksAgent'), false);
});

test('removeFixture stops at the first failing command and never touches the repository after it', async () => {
  const log = [];
  const run = async (command, args) => { log.push(args.join(' ')); return { status: args.includes('ploinky_refused_1') ? 4 : 0, stdout: '' }; };
  await assert.rejects(() => removeFixture({ run, bin: 'ploinky', cwd: '/w', repo: 'hwlFixture', order: ORDER, readSnapshot: async () => fixtureSnapshot() }), /disable agent ploinky_refused_1 failed \(exit 4\)/);
  assert.deepEqual(log, ['disable agent ploinky_static_1', 'disable agent ploinky_dependant_1', 'disable agent ploinky_refused_1']);
  await assert.rejects(() => removeFixture({ run: async () => ({ status: null, error: new Error('spawn ENOENT') }), bin: 'ploinky', cwd: '/w', repo: 'hwlFixture', readSnapshot: async () => fixtureSnapshot() }), /failed \(exit unknown\)/);
  await assert.rejects(() => removeFixture({ run, bin: 'ploinky', cwd: 'relative', repo: 'hwlFixture', readSnapshot: async () => fixtureSnapshot() }), /absolute workspace directory/);
  const none = [];
  await removeFixture({ run: async (command, args) => { none.push(args.join(' ')); return { status: 0 }; }, bin: 'ploinky', cwd: '/w', repo: 'hwlFixture', readSnapshot: async () => ({ agents: [] }) });
  assert.deepEqual(none, ['disable repo hwlFixture']);
});

// ---------------------------------------------------------------------------
// The MPS daemon from the product's own record (NB1)

const daemonReply = (overrides = {}) => ({ status: 'ready', daemon: { pid: 321, recordedStartTime: '10', alive: true, startTime: '10', cgroup: '0::/ploinky/core', ...overrides } });
const recordRun = (reply) => (command, args) => ({ status: 0, stdout: JSON.stringify(reply), args });

test('readMpsDaemon reads the daemon record through the core observer and returns its Box PID and start time', async () => {
  const calls = [];
  const daemon = await readMpsDaemon({ run: (command, args) => { calls.push(args); return { status: 0, stdout: JSON.stringify(daemonReply()) }; }, boxName: BOX });
  assert.deepEqual(daemon, { pid: 321, startTime: '10' });
  assert.deepEqual(calls[0].slice(0, 5), coreArgs(BOX));
  assert.equal(calls[0].includes('node'), true);
  assert.equal(await readMpsDaemon({ run: recordRun({ status: null, daemon: null }), boxName: BOX }), null);
  assert.equal(await readMpsDaemon({ run: recordRun(daemonReply({ alive: false, startTime: null, cgroup: null })), boxName: BOX }), null);
});

test('readMpsDaemon BLOCKS when the record disagrees with /proc', async () => {
  for (const overrides of [{ startTime: '99' }, { cgroup: '0::/ploinky/agents/x' }, { pid: 1 }, { recordedStartTime: 'abc', startTime: 'abc' }]) {
    await assert.rejects(() => readMpsDaemon({ run: recordRun(daemonReply(overrides)), boxName: BOX }), EvidenceBlocked, JSON.stringify(overrides));
  }
  await assert.rejects(() => readMpsDaemon({ run: () => ({ status: 1, stdout: '', stderr: 'unsafe' }), boxName: BOX }), /daemon record read failed/);
});

test('findMpsDaemon maps the Box PID to exactly one host process by NSpid, start time and cgroup, never by name', () => {
  const world = ownershipWorld();
  const find = (daemon) => findMpsDaemon({ observer: world.host, boxPrefix: REAL_PREFIX, daemon });
  assert.deepEqual(find({ pid: 321, startTime: '10' }), { hostPid: 6000, bootId: 'boot-1', startIdentity: '10' });
  // Wrong start time, wrong Box PID, or a record naming the decoy's PID with the real start time: no match.
  assert.throws(() => find({ pid: 321, startTime: '11' }), /exactly one host process .* \(0\)/);
  assert.throws(() => find({ pid: 999, startTime: '10' }), EvidenceBlocked);
  assert.throws(() => find({ pid: 322, startTime: '10' }), EvidenceBlocked);
  // The decoy is selected only by its own recorded identity, and then only because it carries that identity, not its name.
  assert.equal(find({ pid: 322, startTime: '17' }).hostPid, 6007);
  // A process with the right NSpid and start time in another cgroup is not the daemon.
  world.entries[6000] = { ...world.entries[6000], cgroup: `${REAL_PREFIX}/ploinky/agents/libpod-${ID_A}.scope` };
  assert.throws(() => find({ pid: 321, startTime: '10' }), EvidenceBlocked);
  assert.throws(() => findMpsDaemon({ observer: world.host, boxPrefix: REAL_PREFIX, daemon: { pid: 321, startTime: '10' }, candidates: [6000] }), EvidenceBlocked, 'the cgroup is re-checked even for supplied candidates');
  // Two processes with the same identity are ambiguous.
  const twin = ownershipWorld();
  twin.entries[6008] = { ...twin.entries[6000], startIdentity: '10' };
  assert.throws(() => findMpsDaemon({ observer: twin.host, boxPrefix: REAL_PREFIX, daemon: { pid: 321, startTime: '10' }, candidates: [6000, 6008] }), /\(2\)/);
});

test('regression: matching the daemon by the untruncated command name finds nothing, the record-based mapping finds it', () => {
  const world = ownershipWorld();
  const core = `${REAL_PREFIX}/ploinky/core`;
  const byOldName = world.host.cgroupProcs(core).map((pid) => world.host.observe(pid)).filter((seen) => seen.cgroup === core && seen.comm === 'nvidia-cuda-mps-control' && seen.nspid.length === 2 && seen.startIdentity === '10');
  assert.deepEqual(byOldName, [], 'the real daemon reads "nvidia-cuda-mps" in /proc/<pid>/comm, so the old name match cannot find it');
  assert.equal('nvidia-cuda-mps-control'.length > 15 && world.entries[6000].comm === 'nvidia-cuda-mps-control'.slice(0, 15), true);
  assert.equal(findMpsDaemon({ observer: world.host, boxPrefix: REAL_PREFIX, daemon: { pid: 321, startTime: '10' } }).hostPid, 6000);
});

test('the foreign-workspace guard compares real paths, so a symlink into a foreign workspace is refused', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-home-')));
  try {
    fs.mkdirSync(path.join(home, 'work', 'testExplorerFresh', 'inner'), { recursive: true });
    fs.mkdirSync(path.join(home, 'work', 'owned'), { recursive: true });
    fs.symlinkSync(path.join(home, 'work', 'testExplorerFresh', 'inner'), path.join(home, 'work', 'looks-owned'));
    const env = { SMOKE_DEPLOYMENT_MODE: 'box', SMOKE_BASE_URL: 'http://localhost:18080', SMOKE_PLOINKY_BOX_CONTAINER: BOX };
    assert.throws(() => requireHardwareEnvironment({ ...env, SMOKE_WORKSPACE_ROOT: path.join(home, 'work', 'looks-owned') }, { home }), /foreign-workspace guard/);
    assert.doesNotThrow(() => requireHardwareEnvironment({ ...env, SMOKE_WORKSPACE_ROOT: path.join(home, 'work', 'owned') }, { home }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
