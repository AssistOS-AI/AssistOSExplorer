// DGX Spark hardware limits (SMOKE_DGX_SPARK=1): CPU and RAM budgets for local-llm on the GB10, the unified-memory
// refusal of GPU shares, and local-llm's admission against a budget.
//
//   1 the hardware-limits gate is on and prepared (turned on with PLOINKY_BOX_HARDWARE_LIMITS=on ploinky restart when it
//     is off), the Box keeps its GPU wiring and local-llm keeps the unified profile;
//   2 a GPU share is refused for the unified GB10 by the API (policy unchanged) and the panel disables the GPU fields; on
//     the qualified GB10 (PCI 0x2E1210DE, driver 580.178.04) the share is instead accepted, applied and visible in the
//     runner's MPS environment (a cooperative, best-effort share), and clearing restores the unlimited agent;
//   3 a 4 CPU budget with the smallest RAM percentage the unified admission accepts is saved and applied through the
//     panel, and the agent's cgroup leaf and local-llm's own budget agree with it;
//   4 admission sizes the small model against that budget (pool = memory.max) and it runs on the GB10 with no OOM kill
//     since before the Run; whether the runner's GPU memory is charged to the agent's cgroup is recorded, not asserted
//     (on the GB10 cudaMalloc device memory is not charged, so the RAM budget does not bound it); on the qualified GB10
//     the guard's GPU samples are paired with host nvidia-smi samples and must agree;
//   5 a RAM budget below the unified need is refused before launch with admission_incompatible;
//   6 clearing the limits restores the unlimited agent, and the weights are deleted.
import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig, smokeArtifactPath } from '../lib/config.mjs';
import {
  MPS_PIPE_DIRECTORY, SMALL_MODEL_ID, agentByRef, checked, cpuMaxMatches, createHardwareApi, instanceByKey, readLeaf, readRunnerProcesses, readRunningSet,
  resolveMemoryPercent, sameToken, tokenOf, waitFor,
} from '../lib/hardware-limits-evidence.mjs';
import {
  ACTIVE_PHASES, DGX_GPU, LOCAL_LLM_REF, UNIFIED_RUNNER,
  callTool, callToolOk, classifyComputeApps, createPloinky, dgxSparkEnabled, errorCodeOf, hostCgroupOf, listNested,
  nestedNameOf, openLocalLlmDashboard, parseGpuStatus, parseLimitsStatus, readComputeApps, readHostGpu, readMemTotalBytes, requestId, requireDgxSparkEnvironment,
  reserveInBudgetFitPercent, resolveBox, restoreSteps, stopModelIfActive, unifiedFitPercent, unifiedRefusePercent, waitForGraph, waitForPhase, withAdminPage, writeEvidence,
  ensureExplorer,
} from '../lib/dgx-spark.mjs';

const evidenceDir = path.dirname(smokeArtifactPath('dgx-spark', '.keep'));
const screenshot = (page, name) => page.screenshot({ path: smokeArtifactPath('dgx-spark', 'screenshots', name), fullPage: false });
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const GATE_RESTART_MS = 30 * 60_000;
const APPLY_BOUND_MS = 5 * 60_000;
const MODEL_READY_MS = 30 * 60_000;
const CPUS = 4;
const MIB = 1024 * 1024;
const QUALIFIED_PCI_DEVICE_ID = '0x2E1210DE';
const QUALIFIED_DRIVER = '580.178.04';
// The expected tuple comes from the host driver (nvidia-smi), never from the payload under test, so a missing field or a
// wrong refusal in the API fails instead of selecting the other branch.
const qualifiedTuple = (gpu) => gpu?.pciDeviceId === QUALIFIED_PCI_DEVICE_ID && gpu?.driverVersion === QUALIFIED_DRIVER;
const QUALIFIED_SHARE_HELP = 'On the qualified GB10 (driver 580.178.04) a GPU memory share is a best-effort, per-CUDA-process MPS limit on cudaMalloc and managed memory, measured at a 1 GiB limit; managed memory also counts against the RAM limit, and pinned-host and ATS memory count only against the RAM limit.';
const state = {};

test.describe('DGX Spark hardware limits for local-llm @dgx-spark', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!dgxSparkEnabled(), 'Set SMOKE_DGX_SPARK=1 to run the DGX Spark suite.');

  test.beforeAll(async () => {
    state.env = requireDgxSparkEnvironment();
    state.ploinky = createPloinky(state.env);
    state.box = await resolveBox({ ploinky: state.ploinky, workspaceRoot: state.env.workspaceRoot });
  });

  // A failed test skips the rest of this serial block: never leave local-llm under a test budget, a model running, or
  // its weights. The gate stays on; it is the deployment's own setting once this spec turned it on.
  test.afterAll(async ({ browser }) => {
    if (!(state.limitsSaved && !state.limitsCleared) && !(state.modelStarted && !state.weightsDeleted)) return;
    test.setTimeout(10 * 60_000 + 3 * APPLY_BOUND_MS);
    const restored = await withAdminPage(browser, smokeConfig.baseURL, (page) => {
      const steps = [['stop the model', () => stopModelIfActive(page).then((status) => status.phase)]];
      if (state.limitsSaved && !state.limitsCleared) {
        steps.push(['clear and apply local-llm limits', async () => {
          const api = createHardwareApi({ request: page.request });
          const before = await api.readOk();
          const cleared = await api.post({ action: 'clear_agent_limits', expectedToken: tokenOf(before), agentRef: LOCAL_LLM_REF });
          if (cleared.status !== 200) throw new Error(`clear answered ${cleared.status}`);
          const applied = await api.post({ action: 'apply', expectedToken: tokenOf(await api.readOk()), containers: [state.key] });
          if (applied.status !== 200) throw new Error(`apply answered ${applied.status}`);
          return 'cleared';
        }]);
      }
      steps.push(['delete the weights', () => callTool(page, { tool: 'local_llm_weights_delete', args: { modelId: SMALL_MODEL_ID, runnerId: UNIFIED_RUNNER } }).then((reply) => reply.ok || reply.text)]);
      return restoreSteps(steps);
    });
    writeEvidence(evidenceDir, '95-restore.json', restored);
  });

  // ---- helpers ------------------------------------------------------------

  async function openHardwareTab(page) {
    await ensureExplorer(page);
    await page.locator('#accountMenuButton').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    const dialog = page.locator('dialog.expanded-modal-dialog:has(settings-modal)');
    await expect(dialog).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
    await dialog.getByRole('tab', { name: 'Hardware limits' }).click();
    const section = dialog.locator('[data-section="hardware"]');
    await expect(section.locator('article.hardware-policy').first()).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
    return section;
  }

  const policyArticle = (page, section) => section.locator('article.hardware-policy')
    .filter({ has: page.locator('h3').filter({ hasText: new RegExp(`^${escapeRe(LOCAL_LLM_REF)}$`) }) });

  async function saveAndApply(page, fields, key) {
    const section = await openHardwareTab(page);
    const article = policyArticle(page, section);
    await expect(article).toBeVisible();
    for (const [name, value] of Object.entries(fields)) await article.locator(`[data-hardware-field="${name}"]`).fill(String(value));
    await article.getByRole('button', { name: 'Save desired limits' }).click();
    const row = article.locator('table.hardware-instances tbody tr').filter({ has: page.locator('code').filter({ hasText: new RegExp(`^${escapeRe(key)}$`) }) });
    await expect(row).toContainText(/pending/, { timeout: smokeConfig.timeouts.navigation });
    await row.getByRole('button', { name: 'Apply instance' }).click();
    await expect(section.getByText('Apply results')).toBeVisible({ timeout: APPLY_BOUND_MS });
    return section;
  }

  async function appliedSnapshot(api, key) {
    return waitFor(async () => {
      const snapshot = await api.readOk();
      const found = instanceByKey(snapshot, key);
      return found && found.instance.availability === 'ready' && found.instance.limitsState === 'applied' ? snapshot : null;
    }, { timeoutMs: APPLY_BOUND_MS, intervalMs: 2000, label: `${key} to be ready with applied limits` });
  }

  function localLlmInstance(snapshot) {
    const agent = agentByRef(snapshot, LOCAL_LLM_REF);
    expect(agent, 'local-llm must be in the hardware snapshot').toBeTruthy();
    expect(agent.containers.length, 'local-llm must have exactly one instance').toBe(1);
    return { agent, instance: agent.containers[0] };
  }

  async function leafOfLocalLlm(key) {
    const entry = (await readRunningSet({ boxName: state.box.name })).find((candidate) => candidate.name === key);
    expect(entry, `${key} must be in the nested running set`).toBeTruthy();
    return { entry, leaf: await readLeaf({ boxName: state.box.name, containerId: entry.id }) };
  }

  // Waits until local-llm answers its overview again after its container was recreated.
  async function localLlmOverview(page) {
    return waitFor(async () => {
      try { return await callToolOk(page, 'local_llm_overview', {}); } catch { return null; }
    }, { timeoutMs: 5 * 60_000, intervalMs: 5000, label: 'local-llm to answer after its restart' });
  }

  function hostStatus(pid) {
    try {
      const text = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const kb = (name) => Number((new RegExp(`^${name}:\\s+([0-9]+) kB`, 'm').exec(text) || [])[1] ?? NaN) * 1024;
      return { vmRssBytes: kb('VmRSS'), rssAnonBytes: kb('RssAnon'), rssFileBytes: kb('RssFile'), rssShmemBytes: kb('RssShmem') };
    } catch { return null; }
  }

  // A-L2-4: on the qualified GB10 a GPU share is accepted, applied and reaches the runner as a cooperative, best-effort
  // MPS limit. The share is cleared again before the test ends, so the later tests and spec 94 see no stored share.
  async function qualifiedShare(page, api, before) {
    const SM = 50;
    const VRAM = 25;
    // The host reports the qualified tuple, so the API must say so too: a missing field or a refusal fails here.
    expect(before.gpu.eligible, `GPU sharing must be offered on the qualified GB10: ${String(before.gpu.reason || 'no reason').slice(0, 200)}`).toBe(true);
    expect(before.gpu.pciDeviceId).toBe(QUALIFIED_PCI_DEVICE_ID);
    expect(before.gpu.driverVersion).toBe(QUALIFIED_DRIVER);
    expect(before.help.gpu, 'the server help carries the qualified-share sentence').toContain(QUALIFIED_SHARE_HELP);
    expect(before.gpu.memoryModel).toBe('unified');
    expect(before.gpu.unifiedMemory).toMatchObject({ ramLimitCoversGpuAllocations: false, assurance: 'best-effort', enforcement: 'cooperative' });
    expect(before.gpu.unifiedMemory.allocationKinds.map((entry) => entry.kind)).toEqual(['device', 'managed', 'pinned-host', 'pageable']);
    const poolBytes = before.gpu.shareBasis?.bytes;
    expect(before.gpu.shareBasis?.kind, 'the share basis is the unified pool').toBe('unified-pool');
    expect(Number.isSafeInteger(poolBytes) && poolBytes > 0).toBe(true);
    expect(before.gpu.shareBasis.source).toBe('box-envelope');
    expect(poolBytes, 'the pool is the Box memory envelope in whole MiB').toBe(Math.floor(before.envelope.memoryBytes / MIB) * MIB);
    const shareMiB = Math.floor((VRAM * poolBytes) / 100 / MIB);
    const defaultMiB = Math.ceil(shareMiB / 1024) * 1024;
    const { instance } = localLlmInstance(before);
    const key = instance.key;
    await stopModelIfActive(page);

    let section = await openHardwareTab(page);
    let article = policyArticle(page, section);
    await expect(article.locator('[data-hardware-field="smPercent"]')).toBeEnabled();
    await expect(article.locator('[data-hardware-field="vramPercent"]')).toBeEnabled();
    await expect(article.getByText('GPU memory % (unified pool)')).toBeVisible();
    await expect(section).toContainText('GPU memory share: best-effort, per CUDA process (MPS); cooperative: a process that drops the MPS environment is not limited');
    for (const text of ['cudaMalloc device memory: GPU share only', 'Managed memory: RAM limit and GPU share (counted against both)', 'Pinned host memory: RAM limit only', 'ATS (pageable) memory used by the GPU: RAM limit only']) await expect(section).toContainText(text);
    for (const sentence of before.help.gpu) await expect(section.locator('details.hardware-limit-help')).toContainText(sentence);

    state.key = key;
    state.limitsSaved = true;
    state.limitsCleared = false;
    await saveAndApply(page, { smPercent: SM, vramPercent: VRAM }, key);
    const applied = await appliedSnapshot(api, key);
    expect(agentByRef(applied, LOCAL_LLM_REF).configured.gpu).toEqual({ smPercent: SM, vramPercent: VRAM });
    expect(applied.gpu.daemonStatus).toBe('ready');
    expect(applied.gpu.serverDefault).toEqual({ smPercent: SM, vramMiB: defaultMiB, shareMemoryMiB: shareMiB });
    await localLlmOverview(page);

    state.modelStarted = true;
    const started = await callToolOk(page, 'local_llm_run', { requestId: requestId('share-run'), modelId: SMALL_MODEL_ID, runnerId: UNIFIED_RUNNER });
    expect(started.accepted).toBe(true);
    await waitForPhase(page, (status) => status.phase === 'ready' && status.deployment?.phase === 'ready', { timeoutMs: MODEL_READY_MS, label: 'the model to be ready under the GPU share' });
    const processes = await readRunnerProcesses({ boxName: state.box.name, agentName: key });
    expect(processes.length, 'exactly one llama-server runs').toBe(1);
    const mps = Object.fromEntries(Object.entries(processes[0].cuda).filter(([name]) => name.startsWith('CUDA_MPS_')));
    expect(mps, 'the runner carries exactly the three share variables').toEqual({
      CUDA_MPS_PIPE_DIRECTORY: MPS_PIPE_DIRECTORY,
      CUDA_MPS_ACTIVE_THREAD_PERCENTAGE: String(SM),
      CUDA_MPS_PINNED_DEVICE_MEM_LIMIT: `0=${shareMiB}M`,
    });
    const reply = await callToolOk(page, 'local_llm_test_prompt', { prompt: 'Name three uses of a GPU.', maxTokens: 64 });
    expect(reply.text.trim().length).toBeGreaterThan(0);
    const guard = (await callToolOk(page, 'local_llm_status', {})).memoryGuard;
    expect(guard?.gpuBudgetSignal, 'the GPU budget stop does not apply under a known share').toBe('not-applicable');

    await stopModelIfActive(page);
    const cleared = await api.post({ action: 'clear_agent_limits', expectedToken: tokenOf(await api.readOk()), agentRef: LOCAL_LLM_REF });
    expect(cleared.status, JSON.stringify(cleared.body).slice(0, 300)).toBe(200);
    const applyCleared = await api.post({ action: 'apply', expectedToken: tokenOf(await api.readOk()), containers: [key] });
    expect(applyCleared.status, JSON.stringify(applyCleared.body).slice(0, 300)).toBe(200);
    const restored = await appliedSnapshot(api, key);
    expect(agentByRef(restored, LOCAL_LLM_REF).configured, 'clearing leaves no stored share').toEqual({});
    state.limitsSaved = false;
    state.limitsCleared = false;
    await localLlmOverview(page);
    await screenshot(page, '95-gpu-share-qualified.png');
    writeEvidence(evidenceDir, '95-gpu-share-qualified.json', { gpu: before.gpu, helpGpu: before.help.gpu, share: { smPercent: SM, vramPercent: VRAM, shareMiB, defaultMiB, r5Literal: { shareMiB: 30625, defaultMiB: 30720, matchesR5Literal: shareMiB === 30625 && defaultMiB === 30720 } }, serverDefault: applied.gpu.serverDefault, runnerMps: mps, memoryGuard: guard });
  }

  // ---- 1 ------------------------------------------------------------------

  test('the hardware-limits gate is on and prepared, and the Box keeps its GB10 wiring', async ({ page }) => {
    test.setTimeout(GATE_RESTART_MS + 35 * 60_000);
    const graphBefore = (await listNested({ boxName: state.box.name })).filter((entry) => entry.state === 'running').length;
    let limits = parseLimitsStatus(checked(await state.ploinky(['limits', 'status'], { timeoutMs: 60_000 }), 'ploinky limits status'));
    state.gateTransition = null;
    // Only a read that says exactly "off" restarts the workspace; an unreadable or unknown gate fails instead.
    if (!['on', 'off'].includes(limits.gate)) throw new Error(`The hardware-limits gate is neither on nor off: ${limits.gateText || 'unreadable'}.`);
    if (limits.gate === 'off') {
      const started = Date.now();
      const restart = await state.ploinky(['restart'], { timeoutMs: GATE_RESTART_MS, env: { PLOINKY_BOX_HARDWARE_LIMITS: 'on' } });
      state.gateTransition = { from: limits.gate, exit: restart.status, ms: Date.now() - started, tail: restart.stdout.split('\n').slice(-8).join('\n') };
      expect(restart.status, `PLOINKY_BOX_HARDWARE_LIMITS=on ploinky restart failed: ${restart.stderr.slice(-800)}`).toBe(0);
      state.box = await resolveBox({ ploinky: state.ploinky, workspaceRoot: state.env.workspaceRoot });
      limits = parseLimitsStatus(checked(await state.ploinky(['limits', 'status'], { timeoutMs: 60_000 }), 'ploinky limits status'));
    }
    expect(limits.gate, `ploinky limits status: ${limits.gateText}`).toBe('on');
    expect(limits.hostDelegation).toMatch(/controllers cpu memory pids/);
    const running = await waitForGraph({ boxName: state.box.name, minimum: Math.max(graphBefore, 16) });

    const gpu = parseGpuStatus((await state.ploinky(['gpu', 'status'], { timeoutMs: 60_000 })).stdout);
    expect(gpu.agents.map((agent) => agent.ref)).toEqual([LOCAL_LLM_REF]);
    expect(gpu.wiring, 'the gate change must keep the GPU wiring active').toBe('active');
    expect(gpu.desiredFingerprint).toBe(gpu.wiringFingerprint);

    await ensureExplorer(page);
    const api = createHardwareApi({ request: page.request });
    const snapshot = await waitFor(async () => {
      const value = await api.readOk();
      return value.gate?.state === 'on' && value.gate?.prepared === true && value.gate?.backendReady === true ? value : null;
    }, { timeoutMs: 5 * 60_000, intervalMs: 3000, label: 'the hardware snapshot to report a prepared gate' });
    expect(snapshot.gate.controllers).toEqual(expect.arrayContaining(['cpu', 'memory', 'pids']));
    expect(snapshot.envelope.cpus).toBe(20);
    expect(snapshot.envelope.memoryBytes).toBeLessThanOrEqual(readMemTotalBytes());
    expect(snapshot.envelope.memoryBytes).toBeGreaterThan(100 * 1024 ** 3);
    const overview = await localLlmOverview(page);
    expect(overview.profile, 'local-llm keeps the unified profile with the gate on').toBe('unified');
    expect(overview.hardware.gpu.device.pciDeviceId).toBe(DGX_GPU.pciDeviceId);
    state.envelope = snapshot.envelope;
    writeEvidence(evidenceDir, '95-gate.json', { transition: state.gateTransition, limitsStatus: limits.raw, gpuStatus: gpu.raw, gate: snapshot.gate, envelope: snapshot.envelope, gpu: snapshot.gpu, graph: running.length, box: { name: state.box.name, id: state.box.id, startedAt: state.box.startedAt } });
  });

  // ---- 2 ------------------------------------------------------------------

  test('a GPU share is refused for the unified GB10 by the API and the panel unless the driver is qualified', async ({ page }) => {
    test.setTimeout(MODEL_READY_MS + 3 * APPLY_BOUND_MS + 15 * 60_000);
    await ensureExplorer(page);
    const api = createHardwareApi({ request: page.request });
    const before = await api.readOk();
    state.hostGpu = await readHostGpu({});
    state.qualified = qualifiedTuple(state.hostGpu);
    if (state.qualified) return qualifiedShare(page, api, before);
    expect(before.gpu.eligible, 'GPU sharing must not be offered on a unified GPU whose driver is not qualified').toBe(false);
    expect(String(before.gpu.reason || '')).toMatch(/unified|not qualified|unsupported/i);
    const refused = await api.post({ action: 'set_agent_limits', expectedToken: tokenOf(before), agentRef: LOCAL_LLM_REF, limits: { gpu: { smPercent: 50, vramPercent: 50 } } });
    expect(refused.status, JSON.stringify(refused.body).slice(0, 400)).toBeGreaterThanOrEqual(400);
    expect(refused.body.error).toBe('gpu_sharing_unavailable');
    expect(refused.body.committed === true).toBe(false);
    const after = await api.readOk();
    expect(sameToken(tokenOf(after), tokenOf(before)), 'a refused share must not change the policy token').toBe(true);
    expect(agentByRef(after, LOCAL_LLM_REF).configured).toEqual(agentByRef(before, LOCAL_LLM_REF).configured);

    const section = await openHardwareTab(page);
    const article = policyArticle(page, section);
    await expect(article).toBeVisible();
    await expect(article.locator('[data-hardware-field="smPercent"]')).toBeDisabled();
    await expect(article.locator('[data-hardware-field="vramPercent"]')).toBeDisabled();
    await expect(article.locator('[data-hardware-field="cpus"]')).toBeEnabled();
    await expect(article.locator('[data-hardware-field="memoryPercent"]')).toBeEnabled();
    // A-L2-2: the unified disclosure. The API says the RAM limit does not cover GPU device memory (cudaMalloc), and the panel shows the
    // server's help sentences (including the unified one) and the per-Box advisory line.
    expect(before.gpu.memoryModel).toBe('unified');
    expect(before.gpu.unifiedMemory?.ramLimitCoversGpuAllocations).toBe(false);
    expect(before.gpu.unifiedMemory?.assurance).toBe('advisory');
    await expect(section).toContainText('RAM limits on this Box do not cover GPU device memory (advisory)');
    // Drift check between the server's help.gpu and the panel's own GPU_HELP copy (the panel does not render the server's
    // list). toContainText reads textContent, so the <details> may stay closed; the panel's 5 s re-render collapses an open one.
    const help = section.locator('details.hardware-limit-help');
    expect(before.help.gpu.some((sentence) => /unified-memory NVIDIA GPUs \(GB10 \/ DGX Spark\) a RAM limit does not cap the GPU device memory \(cudaMalloc\)/.test(sentence)), 'the server help carries the unified sentence').toBe(true);
    for (const sentence of before.help.gpu) await expect(help).toContainText(sentence);
    await screenshot(page, '95-gpu-share-disabled.png');
    writeEvidence(evidenceDir, '95-gpu-share-refusal.json', { gpu: before.gpu, helpGpu: before.help.gpu, refusal: { status: refused.status, error: refused.body.error, message: String(refused.body.message || refused.body.reason || '').slice(0, 400) } });
  });

  // ---- 3 ------------------------------------------------------------------

  test('a CPU and RAM budget is applied to local-llm and its cgroup leaf and budget agree', async ({ page }) => {
    test.setTimeout(3 * APPLY_BOUND_MS + 10 * 60_000);
    await ensureExplorer(page);
    await stopModelIfActive(page);
    const preview = (await callToolOk(page, 'local_llm_overview', { preview: { modelId: SMALL_MODEL_ID, runnerId: UNIFIED_RUNNER } })).preview;
    expect(preview.admission.status).toBe('ok');
    const api = createHardwareApi({ request: page.request });
    const before = await api.readOk();
    const { instance } = localLlmInstance(before);
    const needBytes = preview.admission.estimate.unifiedBytes;
    const usedBytes = instance.usage?.memoryBytes || 0;
    const fitPercent = unifiedFitPercent({ needBytes, envelopeBytes: before.envelope.memoryBytes, usedBytes });
    const refusePercent = unifiedRefusePercent({ needBytes, envelopeBytes: before.envelope.memoryBytes });
    expect(refusePercent, 'the refusal budget must sit below the fit budget').toBeLessThan(fitPercent);
    // n5 (G3 fix): the budget now only has to hold local-llm's estimate, so it is below the pre-change rule that charged the host reserve inside it.
    expect(fitPercent, 'the fit percentage must be below the pre-change reserve-in-budget rule').toBeLessThan(reserveInBudgetFitPercent({ needBytes, envelopeBytes: before.envelope.memoryBytes, usedBytes }));
    Object.assign(state, { needBytes, fitPercent, refusePercent, key: instance.key });

    const runningBefore = await readRunningSet({ boxName: state.box.name });
    state.limitsSaved = true;
    await saveAndApply(page, { cpus: CPUS, memoryPercent: fitPercent }, instance.key);
    const applied = await appliedSnapshot(api, instance.key);
    const memoryBytes = resolveMemoryPercent(fitPercent, applied.envelope.memoryBytes);
    const found = instanceByKey(applied, instance.key).instance;
    expect(found.limits.cpu).toMatchObject({ cores: CPUS, assurance: 'kernel' });
    expect(found.limits.memory).toMatchObject({ bytes: memoryBytes, assurance: 'kernel' });
    const { entry, leaf } = await leafOfLocalLlm(instance.key);
    const others = runningBefore.filter((candidate) => candidate.name !== instance.key);
    const runningAfter = await readRunningSet({ boxName: state.box.name });
    for (const other of others) expect(runningAfter.find((candidate) => candidate.name === other.name)?.id, `${other.name} must not be recreated`).toBe(other.id);
    expect(cpuMaxMatches(leaf.cpuMax, CPUS), `cpu.max ${leaf.cpuMax}`).toBe(true);
    expect(leaf.memoryMax).toBe(String(memoryBytes));
    expect(leaf.swapMax).toBe('0');

    const overview = await localLlmOverview(page);
    expect(overview.profile, 'the GPU stays attached under a CPU/RAM budget').toBe('unified');
    expect(overview.limits.budget).toMatchObject({ cpus: CPUS, memoryBytes, source: 'ploinky' });
    expect(overview.limits.budget.gpuShare, 'no GPU share applies on the GB10').toBeUndefined();
    const { dashboard } = await openLocalLlmDashboard(page, { timeout: smokeConfig.timeouts.navigation });
    const budgetCard = dashboard.locator('[data-llm-card="budget"]');
    await expect(budgetCard).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
    await expect(budgetCard).toContainText(`${CPUS} CPUs`);
    await screenshot(page, '95-dashboard-budget.png');
    Object.assign(state, { containerId: entry.id, memoryBytes });
    writeEvidence(evidenceDir, '95-budget.json', { needBytes, fitPercent, refusePercent, envelope: applied.envelope, limits: found.limits, leaf: { path: leaf.leaf, cpuMax: leaf.cpuMax, memoryMax: leaf.memoryMax, swapMax: leaf.swapMax, pidsMax: leaf.pidsMax }, localLlmBudget: overview.limits.budget, cgroupMemory: overview.hardware.cgroupMemory });
  });

  // ---- 4 ------------------------------------------------------------------

  test('admission sizes the model against the budget and it runs on the GB10 without an OOM kill', async ({ page }) => {
    test.setTimeout(MODEL_READY_MS + 15 * 60_000);
    expect(state.containerId, 'test 3 must have applied the budget').toBeTruthy();
    await ensureExplorer(page);
    expect(state.hostGpu, 'test 2 must have read the host GPU tuple').toBeTruthy();
    const qualified = state.qualified === true;
    const baseline = await readLeaf({ boxName: state.box.name, containerId: state.containerId });
    state.modelStarted = true;
    const started = await callToolOk(page, 'local_llm_run', { requestId: requestId('budget-run'), modelId: SMALL_MODEL_ID, runnerId: UNIFIED_RUNNER });
    expect(started.deployment.admission.status).toBe('ok');
    expect(started.deployment.admission.estimate.poolBytes, 'admission sizes the model against the budget, not the host').toBe(state.memoryBytes);
    const ready = await waitForPhase(page, (status) => status.phase === 'ready' && status.deployment?.phase === 'ready', { timeoutMs: MODEL_READY_MS, label: 'the model to be ready under the budget' });
    expect(ready.runnerReport.device).toBe(`CUDA0 (${DGX_GPU.name})`);
    expect(ready.runnerReport.offloaded.layers).toBe(ready.runnerReport.offloaded.of);
    const threads = ready.logs.map((line) => /n_threads = ([0-9]+)/.exec(line.line)).filter(Boolean).map((found) => Number(found[1]));

    const samples = [];
    const sample = async (label) => {
      const leaf = await readLeaf({ boxName: state.box.name, containerId: state.containerId });
      const apps = classifyComputeApps(await readComputeApps({}), state.box.id);
      const hostReadAt = Date.now();
      const runner = apps.owned.find((app) => app.name.endsWith('/llama-server')) || null;
      samples.push({ label, at: Date.now(), memoryCurrent: leaf.memoryCurrent, memoryPeak: leaf.memoryPeak, memoryMax: leaf.memoryMax, swapCurrent: leaf.swapCurrent, oomKill: leaf.oomKill, nrThrottled: leaf.nrThrottled, usageUsec: leaf.usageUsec, runnerGpuMiB: runner?.usedMiB ?? null, runnerHost: runner ? hostStatus(runner.pid) : null, runnerCgroup: runner ? hostCgroupOf(runner.pid) : null, foreign: apps.foreign.length });
      // A-L2-5: the guard's own GPU view, read next to the host sample. gpuSampleAt is the epoch ms of the guard's cached sample.
      const guard = (await callToolOk(page, 'local_llm_status', {})).memoryGuard ?? {};
      samples.at(-1).hostReadAt = hostReadAt;
      samples.at(-1).guard = { readAt: Date.now(), gpuSampleAt: guard.gpuSampleAt ?? null, gpuHeldBytes: guard.gpuHeldBytes ?? null, gpuBudgetSignal: guard.gpuBudgetSignal ?? null, gpuSampleExecMsMedian: guard.gpuSampleExecMsMedian ?? null };
      return leaf;
    };
    await sample('ready');
    // The share cleared in test 2 must not leave MPS variables on this budget-only run.
    const runnerEnv = await readRunnerProcesses({ boxName: state.box.name, agentName: state.key });
    expect(runnerEnv.length, 'exactly one llama-server runs').toBe(1);
    expect(Object.keys(runnerEnv[0].cuda).filter((name) => name.startsWith('CUDA_MPS_')), 'no GPU share is stored, so none applies').toEqual([]);
    const prompts = [];
    for (let index = 0; index < 3; index += 1) {
      const reply = await callToolOk(page, 'local_llm_test_prompt', { prompt: 'Write a numbered list of twenty short facts about memory.', maxTokens: 512 });
      expect(reply.text.trim().length).toBeGreaterThan(0);
      prompts.push({ completionTokens: reply.completionTokens, generationTokensPerSecond: reply.generationTokensPerSecond, elapsedMs: reply.elapsedMs });
      await sample(`after-prompt-${index + 1}`);
    }
    const last = samples.at(-1);
    expect(samples.every((entry) => entry.foreign === 0), 'no foreign GPU compute during the window').toBe(true);
    expect(baseline.oomKill, 'the leaf reports memory.events').not.toBeNull();
    expect(last.oomKill, 'no OOM kill since before the Run (loading included)').toBe(baseline.oomKill);
    expect(last.swapCurrent ?? 0, 'no swap under the budget').toBe(0);
    expect(last.memoryPeak, 'the leaf peak stays under memory.max').toBeLessThanOrEqual(state.memoryBytes);
    expect(last.runnerCgroup, 'the runner runs inside the agent leaf').toContain(`libpod-${state.containerId}`);
    const runnerGpuBytes = (last.runnerGpuMiB ?? 0) * 1024 * 1024;
    const unifiedAccounting = {
      runnerGpuBytes,
      leafMemoryCurrent: last.memoryCurrent,
      runnerVmRssBytes: last.runnerHost?.vmRssBytes ?? null,
      // When the leaf holds less than the runner's resident memory plus its GPU memory, cudaMalloc device memory on the
      // unified GB10 is not charged to the agent's memory cgroup (managed, pinned-host and ATS memory are charged), so the
      // RAM budget does not bound it.
      gpuMemoryChargedToLeaf: last.memoryCurrent >= (last.runnerHost?.vmRssBytes ?? 0) + runnerGpuBytes,
    };
    const finalGuard = (await callToolOk(page, 'local_llm_status', {})).memoryGuard;
    // A-L2-5: the guard's GPU budget view against the host driver, only on the qualified tuple.
    let gpuBudget = `not applicable: driver ${state.hostGpu.driverVersion}`;
    if (!qualified) expect(finalGuard?.gpuBudgetSignal, 'local-llm must not qualify a tuple the host reports as unqualified').toBe('unqualified');
    if (qualified) {
      expect(finalGuard?.gpuBudgetSignal, 'the guard observes the runner GPU memory under a budget').toBe('observed');
      const pairs = samples.filter((entry) => entry.runnerGpuMiB != null && Number.isFinite(entry.guard?.gpuSampleAt) && Number.isFinite(entry.guard?.gpuHeldBytes)
        && Math.abs(entry.guard.gpuSampleAt - entry.hostReadAt) <= 3000);
      expect(pairs.length, 'no paired GPU samples').toBeGreaterThanOrEqual(1);
      for (const pair of pairs) {
        const hostBytes = pair.runnerGpuMiB * MIB;
        const tolerance = Math.max(0.1 * hostBytes, 64 * MIB);
        expect(Math.abs(pair.guard.gpuHeldBytes - hostBytes), `guard ${pair.guard.gpuHeldBytes} B against host ${hostBytes} B at ${pair.label}`).toBeLessThanOrEqual(tolerance);
      }
      expect(finalGuard.gpuSampleExecMsMedian, 'the median GPU sample exec time').toBeLessThanOrEqual(200);
      expect(last.runnerGpuMiB, 'the final host sample sees the runner').not.toBeNull();
      expect(Number.isFinite(last.runnerHost?.vmRssBytes), 'the runner resident size is readable').toBe(true);
      expect(unifiedAccounting.gpuMemoryChargedToLeaf, 'cudaMalloc device memory is not charged to the leaf').toBe(false);
      gpuBudget = { pairs: pairs.map((pair) => ({ label: pair.label, runnerGpuMiB: pair.runnerGpuMiB, gpuHeldBytes: pair.guard.gpuHeldBytes, skewMs: pair.guard.gpuSampleAt - pair.hostReadAt })) };
    }
    writeEvidence(evidenceDir, '95-budget-run.json', { threads, prompts, samples, unifiedAccounting, gpuBudget, memoryGuard: finalGuard });
    expect(prompts.every((entry) => entry.generationTokensPerSecond > 0)).toBe(true);
  });

  // ---- 5 ------------------------------------------------------------------

  test('a RAM budget below the unified need refuses the Run before launch', async ({ page }) => {
    test.setTimeout(3 * APPLY_BOUND_MS + 10 * 60_000);
    await ensureExplorer(page);
    await stopModelIfActive(page);
    const api = createHardwareApi({ request: page.request });
    await saveAndApply(page, { memoryPercent: state.refusePercent }, state.key);
    const applied = await appliedSnapshot(api, state.key);
    const memoryBytes = resolveMemoryPercent(state.refusePercent, applied.envelope.memoryBytes);
    const { entry, leaf } = await leafOfLocalLlm(state.key);
    expect(leaf.memoryMax).toBe(String(memoryBytes));
    await localLlmOverview(page);
    const reply = await callTool(page, { tool: 'local_llm_run', args: { requestId: requestId('refused-run'), modelId: SMALL_MODEL_ID, runnerId: UNIFIED_RUNNER } });
    expect(reply.ok, 'the Run must be refused').toBe(false);
    expect(errorCodeOf(reply)).toBe('admission_incompatible');
    expect(reply.text).toMatch(/this agent's Ploinky RAM budget is/);
    const status = await callToolOk(page, 'local_llm_status', {});
    expect(ACTIVE_PHASES.has(String(status.phase || 'idle')), `no deployment may be active (phase ${status.phase})`).toBe(false);
    expect(await readRunnerProcesses({ boxName: state.box.name, agentName: state.key })).toEqual([]);
    state.containerId = entry.id;
    writeEvidence(evidenceDir, '95-refusal.json', { refusePercent: state.refusePercent, memoryBytes, needBytes: state.needBytes, code: errorCodeOf(reply), message: reply.text.slice(0, 600), phase: status.phase });
  });

  // ---- 6 ------------------------------------------------------------------

  test('clearing the limits restores the unlimited agent and the weights are deleted', async ({ page }) => {
    test.setTimeout(3 * APPLY_BOUND_MS);
    await ensureExplorer(page);
    const api = createHardwareApi({ request: page.request });
    const before = await api.readOk();
    const cleared = await api.post({ action: 'clear_agent_limits', expectedToken: tokenOf(before), agentRef: LOCAL_LLM_REF });
    expect(cleared.status, JSON.stringify(cleared.body).slice(0, 300)).toBe(200);
    const pending = await api.readOk();
    const applied = await api.post({ action: 'apply', expectedToken: tokenOf(pending), containers: [state.key] });
    expect(applied.status, JSON.stringify(applied.body).slice(0, 300)).toBe(200);
    const done = await appliedSnapshot(api, state.key);
    expect(agentByRef(done, LOCAL_LLM_REF).configured).toEqual({});
    state.limitsCleared = true;
    const { leaf } = await leafOfLocalLlm(state.key);
    expect(leaf.memoryMax).toBe('max');
    expect(leaf.cpuMax).toMatch(/^max /);
    const overview = await localLlmOverview(page);
    expect(overview.limits.budget ?? null, 'no budget remains').toBeNull();
    expect(overview.profile).toBe('unified');
    const deleted = await callTool(page, { tool: 'local_llm_weights_delete', args: { modelId: SMALL_MODEL_ID, runnerId: UNIFIED_RUNNER } });
    expect(deleted.ok, deleted.text).toBe(true);
    const after = await callToolOk(page, 'local_llm_overview', {});
    expect(after.models.find((model) => model.id === SMALL_MODEL_ID).weights.gguf.download.state).toBe('absent');
    state.weightsDeleted = true;
    writeEvidence(evidenceDir, '95-cleared.json', { leaf: { cpuMax: leaf.cpuMax, memoryMax: leaf.memoryMax }, budget: overview.limits.budget ?? null });
  });
});
