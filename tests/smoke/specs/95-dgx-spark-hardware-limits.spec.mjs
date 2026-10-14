// DGX Spark hardware limits (SMOKE_DGX_SPARK=1): CPU and RAM budgets for local-llm on the GB10, the unified-memory
// refusal of GPU shares, and local-llm's admission against a budget.
//
//   1 the hardware-limits gate is on and prepared (turned on with PLOINKY_BOX_HARDWARE_LIMITS=on ploinky restart when it
//     is off), the Box keeps its GPU wiring and local-llm keeps the unified profile;
//   2 a GPU share is refused for the unified GB10 by the API (policy unchanged) and the panel disables the GPU fields;
//   3 a 4 CPU budget with the smallest RAM percentage the unified admission accepts is saved and applied through the
//     panel, and the agent's cgroup leaf and local-llm's own budget agree with it;
//   4 the small model runs on the GB10 inside that budget: no OOM, no swap, the peak stays under memory.max; the unified
//     accounting (cgroup memory against the runner's GPU memory) is recorded;
//   5 a RAM budget below the unified need is refused before launch with admission_incompatible;
//   6 clearing the limits restores the unlimited agent, and the weights are deleted.
import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig, smokeArtifactPath } from '../lib/config.mjs';
import {
  SMALL_MODEL_ID, agentByRef, cpuMaxMatches, createHardwareApi, instanceByKey, readLeaf, readRunnerProcesses, readRunningSet,
  resolveMemoryPercent, sameToken, tokenOf, waitFor,
} from '../lib/hardware-limits-evidence.mjs';
import {
  ACTIVE_PHASES, DGX_GPU, LOCAL_LLM_REF, UNIFIED_RUNNER,
  callTool, callToolOk, classifyComputeApps, createPloinky, dgxSparkEnabled, errorCodeOf, hostCgroupOf, listNested,
  nestedNameOf, openLocalLlmDashboard, parseGpuStatus, parseLimitsStatus, readComputeApps, readMemTotalBytes, requestId, requireDgxSparkEnvironment,
  resolveBox, stopModelIfActive, unifiedFitPercent, unifiedRefusePercent, waitForGraph, waitForPhase, writeEvidence,
  ensureExplorer,
} from '../lib/dgx-spark.mjs';

const evidenceDir = path.dirname(smokeArtifactPath('dgx-spark', '.keep'));
const screenshot = (page, name) => page.screenshot({ path: smokeArtifactPath('dgx-spark', 'screenshots', name), fullPage: false });
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const GATE_RESTART_MS = 30 * 60_000;
const APPLY_BOUND_MS = 5 * 60_000;
const MODEL_READY_MS = 30 * 60_000;
const CPUS = 4;
const state = {};

test.describe('DGX Spark hardware limits for local-llm @dgx-spark', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!dgxSparkEnabled(), 'Set SMOKE_DGX_SPARK=1 to run the DGX Spark suite.');

  test.beforeAll(async () => {
    state.env = requireDgxSparkEnvironment();
    state.ploinky = createPloinky(state.env);
    state.box = await resolveBox({ ploinky: state.ploinky });
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

  // ---- 1 ------------------------------------------------------------------

  test('the hardware-limits gate is on and prepared, and the Box keeps its GB10 wiring', async ({ page }) => {
    test.setTimeout(GATE_RESTART_MS + 25 * 60_000);
    const graphBefore = (await listNested({ boxName: state.box.name })).filter((entry) => entry.state === 'running').length;
    let limits = parseLimitsStatus((await state.ploinky(['limits', 'status'], { timeoutMs: 60_000 })).stdout);
    state.gateTransition = null;
    if (limits.gate !== 'on') {
      const started = Date.now();
      const restart = await state.ploinky(['restart'], { timeoutMs: GATE_RESTART_MS, env: { PLOINKY_BOX_HARDWARE_LIMITS: 'on' } });
      state.gateTransition = { from: limits.gate, exit: restart.status, ms: Date.now() - started, tail: restart.stdout.split('\n').slice(-8).join('\n') };
      expect(restart.status, `PLOINKY_BOX_HARDWARE_LIMITS=on ploinky restart failed: ${restart.stderr.slice(-800)}`).toBe(0);
      state.box = await resolveBox({ ploinky: state.ploinky });
      limits = parseLimitsStatus((await state.ploinky(['limits', 'status'], { timeoutMs: 60_000 })).stdout);
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

  test('a GPU share is refused for the unified GB10 by the API and the panel', async ({ page }) => {
    await ensureExplorer(page);
    const api = createHardwareApi({ request: page.request });
    const before = await api.readOk();
    expect(before.gpu.eligible, 'GPU sharing must not be offered on a unified GPU').toBe(false);
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
    await screenshot(page, '95-gpu-share-disabled.png');
    writeEvidence(evidenceDir, '95-gpu-share-refusal.json', { gpu: before.gpu, refusal: { status: refused.status, error: refused.body.error, message: String(refused.body.message || refused.body.reason || '').slice(0, 400) } });
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
    const fitPercent = unifiedFitPercent({ needBytes, envelopeBytes: before.envelope.memoryBytes, usedBytes: instance.usage?.memoryBytes || 0 });
    const refusePercent = unifiedRefusePercent({ needBytes, envelopeBytes: before.envelope.memoryBytes });
    expect(refusePercent, 'the refusal budget must sit below the fit budget').toBeLessThan(fitPercent);
    Object.assign(state, { needBytes, fitPercent, refusePercent, key: instance.key });

    const runningBefore = await readRunningSet({ boxName: state.box.name });
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

  test('the small model runs on the GB10 inside the budget', async ({ page }) => {
    test.setTimeout(MODEL_READY_MS + 15 * 60_000);
    expect(state.containerId, 'test 3 must have applied the budget').toBeTruthy();
    await ensureExplorer(page);
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
      const runner = apps.owned.find((app) => app.name.endsWith('/llama-server')) || null;
      samples.push({ label, at: Date.now(), memoryCurrent: leaf.memoryCurrent, memoryPeak: leaf.memoryPeak, memoryMax: leaf.memoryMax, swapCurrent: leaf.swapCurrent, oomKill: leaf.oomKill, nrThrottled: leaf.nrThrottled, usageUsec: leaf.usageUsec, runnerGpuMiB: runner?.usedMiB ?? null, runnerHost: runner ? hostStatus(runner.pid) : null, runnerCgroup: runner ? hostCgroupOf(runner.pid) : null, foreign: apps.foreign.length });
      return leaf;
    };
    const first = await sample('ready');
    const prompts = [];
    for (let index = 0; index < 3; index += 1) {
      const reply = await callToolOk(page, 'local_llm_test_prompt', { prompt: 'Write a numbered list of twenty short facts about memory.', maxTokens: 512 });
      expect(reply.text.trim().length).toBeGreaterThan(0);
      prompts.push({ completionTokens: reply.completionTokens, generationTokensPerSecond: reply.generationTokensPerSecond, elapsedMs: reply.elapsedMs });
      await sample(`after-prompt-${index + 1}`);
    }
    const last = samples.at(-1);
    expect(samples.every((entry) => entry.foreign === 0), 'no foreign GPU compute during the window').toBe(true);
    expect(last.oomKill ?? 0, 'no OOM kill under the budget').toBe(first.oomKill ?? 0);
    expect(last.swapCurrent ?? 0, 'no swap under the budget').toBe(0);
    expect(last.memoryPeak, 'the leaf peak stays under memory.max').toBeLessThanOrEqual(state.memoryBytes);
    expect(last.runnerCgroup, 'the runner runs inside the agent leaf').toContain(`libpod-${state.containerId}`);
    const runnerGpuBytes = (last.runnerGpuMiB ?? 0) * 1024 * 1024;
    const unifiedAccounting = {
      runnerGpuBytes,
      leafMemoryCurrent: last.memoryCurrent,
      runnerVmRssBytes: last.runnerHost?.vmRssBytes ?? null,
      // When the leaf holds less than the runner's resident memory plus its GPU memory, CUDA allocations on the unified
      // GB10 are not charged to the agent's memory cgroup, and the RAM budget does not bound them.
      gpuMemoryChargedToLeaf: last.memoryCurrent >= (last.runnerHost?.vmRssBytes ?? 0) + runnerGpuBytes,
    };
    writeEvidence(evidenceDir, '95-budget-run.json', { threads, prompts, samples, unifiedAccounting, memoryGuard: (await callToolOk(page, 'local_llm_status', {})).memoryGuard });
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
    expect(reply.text).toMatch(/must keep 16\.0 GiB for the host/);
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
    writeEvidence(evidenceDir, '95-cleared.json', { leaf: { cpuMax: leaf.cpuMax, memoryMax: leaf.memoryMax }, budget: overview.limits.budget ?? null });
  });
});
