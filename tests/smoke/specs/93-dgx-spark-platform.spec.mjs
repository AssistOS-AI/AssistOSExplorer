// DGX Spark platform (SMOKE_DGX_SPARK=1): the GB10 host, the Box's NVIDIA wiring, the one GPU agent, and the unified
// profile local-llm commits on it. Read-only: nothing here changes the deployment.
//
//   1 the host is a DGX Spark GB10 and no foreign process computes on its GPU;
//   2 the Box gets exactly the NVIDIA device nodes, read-only driver libraries, no privilege, and only the two publications;
//   3 local-llm is the only nested agent that requests the CDI GPU, and it sees the same GB10 and driver as the host;
//   4 local-llm commits the unified profile with the host's memory pool and its documented reserve and floor;
//   5 unified admission accepts the small model on llama.cpp and refuses runners this image does not ship;
//   6 the Local LLMs dashboard shows one unified-memory card for the GB10.
import path from 'node:path';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig, smokeArtifactPath } from '../lib/config.mjs';
import { SMALL_MODEL_ID, SMALL_MODEL_SIZE } from '../lib/hardware-limits-evidence.mjs';
import {
  BOX_NVIDIA_DEVICES, DGX_GPU, GPU_CDI_DEVICE, LOCAL_LLM_REF, UNIFIED_FLOOR_BYTES, UNIFIED_HOST_RESERVE_BYTES, UNIFIED_RUNNER,
  boxPublications, callToolOk, classifyComputeApps, createCommandDevices, createCommandFlags, createPloinky, dgxSparkEnabled,
  execBox, execNested, inspectNested, listNested, nestedNameOf, parseGpuQuery, GPU_QUERY_FIELDS, readComputeApps, readHostGpu,
  readMemTotalBytes, openLocalLlmDashboard, requireDgxSparkEnvironment, resolveBox, writeEvidence,
  ensureExplorer,
} from '../lib/dgx-spark.mjs';

const evidenceDir = path.dirname(smokeArtifactPath('dgx-spark', '.keep'));
const state = {};

test.describe('DGX Spark platform and GPU wiring @dgx-spark', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!dgxSparkEnabled(), 'Set SMOKE_DGX_SPARK=1 to run the DGX Spark suite.');

  test.beforeAll(async () => {
    state.env = requireDgxSparkEnvironment();
    state.ploinky = createPloinky(state.env);
    state.box = await resolveBox({ ploinky: state.ploinky, workspaceRoot: state.env.workspaceRoot });
    state.nested = await listNested({ boxName: state.box.name });
    state.localLlm = nestedNameOf(state.nested, LOCAL_LLM_REF);
  });

  test('the host is a DGX Spark GB10 and no foreign process computes on its GPU', async () => {
    const gpu = await readHostGpu({});
    expect(process.arch).toBe('arm64');
    expect(gpu.name).toBe(DGX_GPU.name);
    expect(gpu.pciDeviceId).toBe(DGX_GPU.pciDeviceId);
    expect(gpu.computeCapability).toBe(DGX_GPU.computeCapability);
    expect(gpu.addressingMode).toBe(DGX_GPU.addressingMode);
    expect(gpu.memoryTotal, 'a unified GB10 reports no dedicated memory').toMatch(/N\/A/);
    expect(gpu.uuid).toMatch(/^GPU-[a-f0-9-]{36}$/i);
    const memTotalBytes = readMemTotalBytes();
    expect(memTotalBytes, 'a DGX Spark has about 128 GB of unified memory').toBeGreaterThan(100 * 1024 ** 3);
    const apps = classifyComputeApps(await readComputeApps({}), state.box.id);
    writeEvidence(evidenceDir, '93-host.json', { gpu, memTotalBytes, box: { name: state.box.name, id: state.box.id, imageId: state.box.imageId, startedAt: state.box.startedAt }, computeApps: apps });
    expect(apps.foreign, `foreign GPU compute processes would distort this suite: ${JSON.stringify(apps.foreign)}`).toEqual([]);
    Object.assign(state, { hostGpu: gpu, memTotalBytes });
  });

  test('the Box gets the NVIDIA device nodes and driver libraries read-only, without privilege', async () => {
    const status = state.box.gpu;
    expect(status.agents.map((agent) => agent.ref), 'local-llm must be the only GPU agent').toEqual([LOCAL_LLM_REF]);
    expect(status.manifestDeclarations).toEqual([LOCAL_LLM_REF]);
    expect(status.boxState).toBe('running');
    expect(status.wiring, 'the Box GPU wiring must be active').toBe('active');
    expect(status.wiringFingerprint).toMatch(/^[a-f0-9]{12}$/);
    expect(status.desiredFingerprint, 'the running wiring must be the desired one').toBe(status.wiringFingerprint);
    expect(status.hostGpu).toContain(`driver ${state.hostGpu.driverVersion}`);
    expect(state.box.labels['io.assistos.ploinky-box.gpu-grant'], 'the Box label carries the wiring fingerprint').toMatch(new RegExp(`^${status.wiringFingerprint}[a-f0-9]{52}$`));

    const record = state.box.record;
    const create = record.Config?.CreateCommand || [];
    const devices = createCommandDevices(create);
    for (const node of BOX_NVIDIA_DEVICES) expect(devices, `the Box must receive ${node}`).toContain(node);
    expect(devices.filter((node) => /nvidia/.test(node)).sort(), 'no NVIDIA device beyond the three required nodes').toEqual([...BOX_NVIDIA_DEVICES].sort());
    const binds = createCommandFlags(create, '--volume').concat(createCommandFlags(create, '-v'));
    const driverBinds = binds.filter((bind) => /nvidia|libcuda/.test(bind));
    expect(driverBinds.length, 'the driver libraries and nvidia-smi are bound into the Box').toBeGreaterThanOrEqual(4);
    for (const bind of driverBinds) expect(bind, `driver bind ${bind} must be read-only`).toMatch(/:ro$/);
    expect(record.HostConfig?.Privileged).toBe(false);
    expect(record.HostConfig?.CapAdd || []).toEqual([]);
    expect(create.some((arg) => /^--gpus/.test(String(arg))), 'the Box must not use --gpus').toBe(false);
    expect(boxPublications(record)).toEqual(['0.0.0.0:7882->7882/udp', '127.0.0.1:8080->8080/tcp']);

    const inBox = await execBox({ boxName: state.box.name, argv: ['sh', '-c', 'ls /dev/nvidia0 /dev/nvidiactl /dev/nvidia-uvm && cat /etc/cdi/ploinky-gpu.json'] });
    expect(inBox.status, inBox.stderr).toBe(0);
    expect(inBox.stdout).toContain('ploinky.local/gpu');
    writeEvidence(evidenceDir, '93-box-wiring.json', { gpuStatus: status.raw, devices, driverBinds, publications: boxPublications(record), privileged: record.HostConfig?.Privileged, capAdd: record.HostConfig?.CapAdd || [] });
  });

  test('local-llm is the only nested agent that requests the CDI GPU and it sees the host GB10', async () => {
    const names = state.nested.filter((entry) => entry.state === 'running').map((entry) => entry.name);
    expect(names, 'local-llm must be running').toContain(state.localLlm);
    const records = await inspectNested({ boxName: state.box.name, names });
    const gpuAgents = records.filter((record) => createCommandDevices(record.Config?.CreateCommand).includes(GPU_CDI_DEVICE)).map((record) => String(record.Name).replace(/^\//, ''));
    expect(gpuAgents, `only local-llm may request ${GPU_CDI_DEVICE}`).toEqual([state.localLlm]);
    const withGpuEnv = records.filter((record) => (record.Config?.Env || []).some((entry) => entry.startsWith('PLOINKY_GPU_STATUS='))).map((record) => String(record.Name).replace(/^\//, ''));
    expect(withGpuEnv).toEqual([state.localLlm]);
    const local = records.find((record) => String(record.Name).replace(/^\//, '') === state.localLlm);
    expect(local.Config.Env).toContain('PLOINKY_GPU_STATUS=attached');
    for (const record of records) {
      expect(record.HostConfig?.Privileged, `${record.Name} must not be privileged`).toBe(false);
      expect(createCommandFlags(record.Config?.CreateCommand, '--gpus'), `${record.Name} must not use --gpus`).toEqual([]);
    }

    const inside = await execNested({ boxName: state.box.name, name: state.localLlm, argv: ['nvidia-smi', `--query-gpu=${GPU_QUERY_FIELDS.join(',')}`, '--format=csv,noheader'] });
    expect(inside.status, `nvidia-smi inside local-llm: ${inside.stderr.slice(0, 300)}`).toBe(0);
    const seen = parseGpuQuery(inside.stdout);
    expect(seen).toEqual(state.hostGpu);
    writeEvidence(evidenceDir, '93-gpu-agents.json', { nested: names.length, gpuAgents, gpuEnv: withGpuEnv, insideLocalLlm: seen });
  });

  test('local-llm commits the unified profile with the host memory pool, reserve and floor', async ({ page }) => {
    await ensureExplorer(page);
    const overview = await callToolOk(page, 'local_llm_overview', {});
    state.overview = overview;
    expect(overview.profile).toBe('unified');
    expect(overview.profileDecision).toMatchObject({ profile: 'unified', cause: 'gpu', gpuName: DGX_GPU.name });
    const gpu = overview.hardware?.gpu || {};
    expect(gpu).toMatchObject({ available: true, name: DGX_GPU.name, memoryModel: 'unified', driverVersion: state.hostGpu.driverVersion, totalBytes: null, usedBytes: null, freeBytes: null });
    expect(gpu.device).toEqual({ pciDeviceId: DGX_GPU.pciDeviceId, computeCapability: DGX_GPU.computeCapability, addressingMode: DGX_GPU.addressingMode });
    expect(overview.hardware.memory.totalBytes, 'the pool is the host MemTotal').toBe(state.memTotalBytes);
    expect(overview.limits).toMatchObject({ hostReserveBytes: UNIFIED_HOST_RESERVE_BYTES, floorBytes: UNIFIED_FLOOR_BYTES });
    const runners = Object.fromEntries((overview.runners || []).map((runner) => [runner.id, runner]));
    expect(runners[UNIFIED_RUNNER], 'the CUDA llama.cpp runner is baked into the image').toMatchObject({ supported: true, installed: true, enabled: true });
    expect(runners[UNIFIED_RUNNER].version).toMatch(/^b[0-9]+$/);
    expect(runners['llama.cpp-cpu'], 'the CPU-only build is hidden on a GPU host').toBeUndefined();
    expect(runners['llama.cpp-vulkan'], 'the Vulkan build is hidden on an NVIDIA host').toBeUndefined();
    for (const id of ['ollama', 'ik_llama.cpp', 'tabbyapi']) {
      expect(runners[id]?.supported, `${id} is not shipped for unified arm64`).toBe(false);
      expect(String(runners[id]?.reason || '')).toMatch(/not available on this platform/);
    }
    expect(runners.vllm?.supported, 'vLLM stays an experimental on-demand runner').toBe(true);
    expect(runners.vllm?.installed).toBe(false);
    expect(overview.gatewayModel).toBe('soul_gateway/local-llms/local-llm/default');
    writeEvidence(evidenceDir, '93-overview.json', { profile: overview.profile, profileDecision: overview.profileDecision, limits: overview.limits, gpu, memory: overview.hardware.memory, cpus: overview.hardware.cpus, cgroupMemory: overview.hardware.cgroupMemory, runners: Object.values(runners).map(({ id, supported, installed, enabled, version, reason }) => ({ id, supported, installed, enabled, version, reason })) });
  });

  test('unified admission accepts the small model on llama.cpp and refuses runners the image lacks', async ({ page }) => {
    await ensureExplorer(page);
    const preview = async (modelId, runnerId) => (await callToolOk(page, 'local_llm_overview', { preview: { modelId, runnerId } })).preview;
    const small = await preview(SMALL_MODEL_ID, UNIFIED_RUNNER);
    expect(small.admission.status).toBe('ok');
    const estimate = small.admission.estimate;
    expect(estimate).toMatchObject({ weightsBytes: SMALL_MODEL_SIZE, poolBytes: state.memTotalBytes, hostReserveBytes: UNIFIED_HOST_RESERVE_BYTES, floorBytes: UNIFIED_FLOOR_BYTES, envelope: null });
    expect(estimate.unifiedBytes, 'the unified estimate covers weights, KV, compute, runtime and the prompt cache').toBe(
      estimate.weightsBytes + estimate.kvBytes + estimate.computeBytes + estimate.mtpBytes + estimate.runtimeBytes + estimate.cacheRamBytes);
    const ollama = await preview(SMALL_MODEL_ID, 'ollama');
    expect(ollama.admission.status).toBe('incompatible');
    expect(ollama.admission.reason).toMatch(/Ollama is not available on this platform/);
    state.smallEstimate = estimate;
    writeEvidence(evidenceDir, '93-admission.json', { small: small.admission, ollama: ollama.admission });
  });

  test('the Local LLMs dashboard shows the unified-memory card for the GB10', async ({ page }) => {
    await ensureExplorer(page);
    const { dashboard } = await openLocalLlmDashboard(page, { timeout: smokeConfig.timeouts.navigation });
    const unified = dashboard.locator('[data-llm-card="unified"]');
    await expect(unified).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
    await expect(unified).toContainText('Unified memory available');
    await expect(unified).toContainText(`${DGX_GPU.name} shares system memory`);
    await expect(dashboard.locator('[data-llm-card="gpu"]'), 'a unified GPU gets no separate VRAM card').toHaveCount(0);
    await page.screenshot({ path: smokeArtifactPath('dgx-spark', 'screenshots', '93-dashboard-unified.png') });
  });
});
