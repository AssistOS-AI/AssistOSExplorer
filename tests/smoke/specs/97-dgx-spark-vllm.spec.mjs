// DGX Spark vLLM (SMOKE_DGX_SPARK=1): the experimental vLLM runner on the GB10's unified memory, end to end.
//
//   1 a Hugging Face model pinned to one commit is added through local_llm_model_lookup and local_llm_model_add, and
//     with the operator switch off vLLM is refused for it with the switch's own instructions;
//   2 `ploinky var LOCAL_LLM_VLLM_UNIFIED experimental` and a local-llm restart enable vLLM, which installs from the
//     image's runner lock; admission sizes it from the requested GPU memory share of the unified pool;
//   3 the model runs on vLLM with a 0.1 share, the host sees the vLLM engine as this Box's only GPU compute process,
//     and three test prompts answer;
//   4 Stop frees the GPU, and the weights, the model, the vLLM install this spec made and the switch are removed.
// The switch's earlier value is read first and put back at the end (an operator's `experimental` survives; anything
// else ends as `off`, because ploinky var has no unset). The afterAll undoes whatever a failed test left behind.
// vLLM downloads about 3.9 GB and the model about 1 GB.
import path from 'node:path';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeArtifactPath, smokeConfig } from '../lib/config.mjs';
import { waitFor } from '../lib/hardware-limits-evidence.mjs';
import {
  ACTIVE_PHASES, callTool, callToolOk, classifyComputeApps, createPloinky, dgxSparkEnabled, ensureExplorer, readComputeApps,
  requestId, requireDgxSparkEnvironment, resolveBox, restoreSteps, stopModelIfActive, waitForPhase, withAdminPage, writeEvidence,
} from '../lib/dgx-spark.mjs';

const evidenceDir = path.dirname(smokeArtifactPath('dgx-spark', '.keep'));
const VLLM = 'vllm';
const VLLM_VERSION = '0.30.0';
const SWITCH = 'LOCAL_LLM_VLLM_UNIFIED';
const MODEL_ID = 'dgx-qwen2.5-0.5b-instruct-hf';
const REPO = 'Qwen/Qwen2.5-0.5B-Instruct';
const COMMIT = '7ae557604adf67be50417f59c2c2f167def9a775';
const WEIGHTS = Object.freeze({ path: 'model.safetensors', size: 988097824, sha256: 'fdf756fa7fcbe7404d5c60e26bff1a0c8b8aa1f72ced49e7dd0210fe288fb7fe' });
const SHARE = 0.1;
const PARAMS = Object.freeze({ maxModelLen: 4096, gpuMemoryUtilization: SHARE });
const INSTALL_MS = 30 * 60_000;
const MODEL_READY_MS = 30 * 60_000;
const state = {};

test.describe('DGX Spark vLLM on the GB10 @dgx-spark', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!dgxSparkEnabled(), 'Set SMOKE_DGX_SPARK=1 to run the DGX Spark suite.');

  test.beforeAll(async () => {
    state.env = requireDgxSparkEnvironment();
    state.ploinky = createPloinky(state.env);
    state.box = await resolveBox({ ploinky: state.ploinky, workspaceRoot: state.env.workspaceRoot });
    const echoed = await state.ploinky(['echo', SWITCH], { timeoutMs: 60_000 });
    const found = new RegExp(`^${SWITCH}=(.*)$`, 'm').exec(echoed.stdout);
    if (echoed.status !== 0 || !found) throw new Error(`ploinky echo ${SWITCH} gave no value line (exit ${echoed.status}).`);
    state.priorSwitch = found[1].trim();
    state.restoreSwitch = state.priorSwitch === 'experimental' ? 'experimental' : 'off';
  });

  // Sets the operator switch and restarts only local-llm, which reads it at start.
  async function setSwitch(value) {
    for (const args of [['var', SWITCH, value], ['restart', 'local-llm']]) {
      const result = await state.ploinky(args, { timeoutMs: 10 * 60_000 });
      if (result.status !== 0) throw new Error(`ploinky ${args.join(' ')} exited ${result.status}: ${result.stderr.slice(-400)}`);
    }
  }

  async function overview(page) {
    return waitFor(async () => {
      const reply = await callTool(page, { tool: 'local_llm_overview', args: {} }).catch(() => null);
      return reply?.ok ? reply.value : null;
    }, { timeoutMs: 5 * 60_000, intervalMs: 5000, label: 'local-llm to answer' });
  }

  const runnerOf = (value) => (value.runners || []).find((runner) => runner.id === VLLM) || {};
  const modelOf = (value) => (value.models || []).find((model) => model.id === MODEL_ID) || null;
  const preview = async (page, params) => (await callToolOk(page, 'local_llm_overview', { preview: { modelId: MODEL_ID, runnerId: VLLM, ...(params ? { params } : {}) } })).preview;

  // A failed test skips the rest of this serial block: stop the model and remove what this spec created.
  test.afterAll(async ({ browser }) => {
    if (state.cleaned || !(state.modelStarted || state.modelAdded || state.switchOn || state.installedBySpec)) return;
    test.setTimeout(30 * 60_000);
    const must = async (page, tool, args) => {
      const reply = await callTool(page, { tool, args });
      if (!reply.ok) throw new Error(`${tool} failed: ${reply.text.slice(0, 300)}`);
      return tool;
    };
    const steps = [];
    steps.push(['stop, delete weights, remove model and vLLM', () => withAdminPage(browser, smokeConfig.baseURL, async (page) => {
      await stopModelIfActive(page);
      const done = [];
      if (state.modelAdded) {
        done.push(await must(page, 'local_llm_weights_delete', { modelId: MODEL_ID, runnerId: VLLM }));
        done.push(await must(page, 'local_llm_model_remove', { modelId: MODEL_ID }));
      }
      if (state.installedBySpec) done.push(await must(page, 'local_llm_runner_uninstall', { runnerId: VLLM }));
      return done;
    })]);
    if (state.switchOn) steps.push([`put the switch back to ${state.restoreSwitch}`, () => setSwitch(state.restoreSwitch).then(() => state.restoreSwitch)]);
    writeEvidence(evidenceDir, '97-restore.json', await restoreSteps(steps));
  });

  test('a pinned Hugging Face model is added and vLLM is refused while the switch is off', async ({ page }) => {
    test.setTimeout(15 * 60_000);
    await ensureExplorer(page);
    // Fail before changing anything when an earlier, interrupted run left its model behind.
    const before = await overview(page);
    expect(modelOf(before), `${MODEL_ID} is left over from an interrupted run: delete its weights (local_llm_weights_delete `
      + `with runnerId vllm) and remove it (local_llm_model_remove), and uninstall vLLM if that run installed it`).toBeNull();
    expect(before.profile, 'the GPU must be attached (unified profile)').toBe('unified');
    await stopModelIfActive(page);
    state.switchOn = true;
    await setSwitch('off');

    const lookup = await callToolOk(page, 'local_llm_model_lookup', { repo: REPO, revision: COMMIT, format: 'hf' });
    expect(lookup).toMatchObject({ provider: 'huggingface', repo: REPO, commit: COMMIT, format: 'hf', gated: false });
    expect(lookup.files.find((file) => file.file === WEIGHTS.path)).toMatchObject({ size: WEIGHTS.size, sha256: WEIGHTS.sha256 });
    expect(lookup.sizing.memory.kvBytesPerToken).toBeGreaterThan(0);
    const model = {
      id: MODEL_ID, displayName: 'Qwen2.5 0.5B Instruct (HF, DGX E2E)', license: lookup.license,
      architecture: lookup.sizing.architecture, contextLength: lookup.sizing.contextLength, profiles: ['unified'],
      sources: { hf: { type: 'hf-snapshot', repo: REPO, revision: COMMIT, commit: COMMIT,
        files: lookup.files.map((file) => ({ path: file.file, size: file.size, ...(file.sha256 ? { sha256: file.sha256 } : { gitOid: file.gitOid }) })) } },
      memory: lookup.sizing.memory,
    };
    const added = await callToolOk(page, 'local_llm_model_add', { model });
    state.modelAdded = true;
    expect(added.model.sources.hf).toMatchObject({ type: 'hf-snapshot', repo: REPO, commit: COMMIT });
    expect(added.model.profiles).toEqual(['unified']);

    const refused = await preview(page, PARAMS);
    expect(refused.admission.status).toBe('incompatible');
    expect(refused.admission.reason).toMatch(new RegExp(`experimental on unified memory and is not enabled.*ploinky var ${SWITCH} experimental`));
    writeEvidence(evidenceDir, '97-model.json', { lookup: { commit: lookup.commit, files: lookup.files.length, sizing: lookup.sizing }, added: { id: added.model.id, size: added.model.sources.hf.size }, refusal: refused.admission.reason });
  });

  test('the experimental switch enables vLLM, which installs from the image runner lock', async ({ page }) => {
    test.setTimeout(INSTALL_MS + 15 * 60_000);
    expect(state.modelAdded, 'test 1 must have added the model').toBe(true);
    state.switchOn = true;
    await setSwitch('experimental');
    await ensureExplorer(page);
    let value = await overview(page);
    expect(runnerOf(value)).toMatchObject({ supported: true, enabled: true, pinnedVersion: VLLM_VERSION });
    const started = Date.now();
    if (!runnerOf(value).installed) {
      state.installedBySpec = true;
      const install = await callToolOk(page, 'local_llm_runner_install', { runnerId: VLLM });
      expect(install).toMatchObject({ accepted: true, install: { version: VLLM_VERSION } });
      value = await waitFor(async () => {
        const current = await overview(page);
        const runner = runnerOf(current);
        if (runner.install?.state?.error) throw new Error(`The vLLM install failed: ${JSON.stringify(runner.install.state.error).slice(0, 300)}`);
        return runner.installed ? current : null;
      }, { timeoutMs: INSTALL_MS, intervalMs: 10_000, label: 'vLLM to install' });
    }
    expect(runnerOf(value)).toMatchObject({ installed: true, version: VLLM_VERSION, enabled: true });

    const sized = await preview(page, PARAMS);
    expect(sized.admission.status).toBe('ok');
    const estimate = sized.admission.estimate;
    expect(estimate).toMatchObject({ experimental: true, gpuMemoryUtilization: SHARE, poolBytes: value.hardware.memory.totalBytes });
    // admitUnifiedVllm: Math.round(share x the physical pool), whatever container budget caps poolBytes.
    const memory = value.hardware.memory;
    const denominator = Number.isFinite(memory.physicalTotalBytes) && memory.physicalTotalBytes > 0 ? memory.physicalTotalBytes : memory.totalBytes;
    expect(estimate.budgetBytes, 'vLLM gets exactly the requested share of the unified pool').toBe(Math.round(SHARE * denominator));
    // Recorded, not asserted: without a share vLLM takes what is free now (up to 0.9 of the pool) for any model.
    const unbounded = await preview(page, { maxModelLen: PARAMS.maxModelLen });
    writeEvidence(evidenceDir, '97-install.json', { installedBySpec: Boolean(state.installedBySpec), installMs: Date.now() - started, runner: runnerOf(value), sharedEstimate: estimate, defaultShare: { status: unbounded.admission.status, gpuMemoryUtilization: unbounded.admission.estimate?.gpuMemoryUtilization ?? null, budgetBytes: unbounded.admission.estimate?.budgetBytes ?? null } });
  });

  test('the model runs on vLLM on the GB10 and answers', async ({ page }) => {
    test.setTimeout(MODEL_READY_MS + 10 * 60_000);
    await ensureExplorer(page);
    const foreign = classifyComputeApps(await readComputeApps({}), state.box.id).foreign;
    expect(foreign, `foreign GPU compute processes: ${JSON.stringify(foreign)}`).toEqual([]);
    state.modelStarted = true;
    const started = await callToolOk(page, 'local_llm_run', { requestId: requestId('vllm-run'), modelId: MODEL_ID, runnerId: VLLM, params: PARAMS });
    expect(started.deployment).toMatchObject({ modelId: MODEL_ID, runnerId: VLLM, profile: 'unified' });
    expect(started.deployment.admission.status).toBe('ok');
    const ready = await waitForPhase(page, (status) => status.phase === 'ready' && status.deployment?.phase === 'ready', { timeoutMs: MODEL_READY_MS, label: `${MODEL_ID} on vLLM to be ready` });
    expect(ready.deployment.runnerId).toBe(VLLM);
    expect(ready.deployment.params.gpuMemoryUtilization, 'the run keeps the requested share').toBe(SHARE);
    expect(ready.deployment.admission.estimate.gpuMemoryUtilization).toBe(SHARE);
    expect(ready.runnerReport.modelMiB, 'vLLM reports the loaded weights').toBeGreaterThan(0);
    expect(ready.runnerReport.kvMiB, 'vLLM reports its KV cache').toBeGreaterThan(0);
    expect(ready.memoryGuard.minAvailableBytes).toBeGreaterThan(ready.memoryGuard.floorBytes);
    const apps = classifyComputeApps(await readComputeApps({}), state.box.id);
    expect(apps.foreign).toEqual([]);
    expect(apps.owned.length, 'the vLLM engine is the Box\'s one GPU compute process').toBe(1);
    expect(apps.owned[0].name).toMatch(/vllm/i);
    expect(apps.owned[0].usedMiB).toBeGreaterThan(0);
    const budgetMiB = ready.deployment.admission.estimate.budgetBytes / (1024 * 1024);
    expect(apps.owned[0].usedMiB, 'the engine stays within its share (5 % margin for CUDA context)').toBeLessThanOrEqual(budgetMiB * 1.05);

    const prompts = [];
    for (const prompt of ['Name three uses of a GPU.', 'Explain unified memory in two sentences.', 'Write a haiku about a datacenter.']) {
      const reply = await callToolOk(page, 'local_llm_test_prompt', { prompt, maxTokens: 128 });
      expect(reply.text.trim().length, `vLLM answered nothing to "${prompt}"`).toBeGreaterThan(0);
      expect(reply).toMatchObject({ modelId: MODEL_ID, runnerId: VLLM });
      expect(reply.completionTokens).toBeGreaterThan(0);
      expect(reply.generationTokensPerSecond).toBeGreaterThan(0);
      prompts.push({ completionTokens: reply.completionTokens, generationTokensPerSecond: reply.generationTokensPerSecond, elapsedMs: reply.elapsedMs, statsSource: reply.statsSource });
    }
    writeEvidence(evidenceDir, '97-run.json', { deployment: { id: ready.deployment.id, params: ready.deployment.params, admission: ready.deployment.admission }, runnerReport: ready.runnerReport, memoryGuard: ready.memoryGuard, gpuProcesses: apps.owned, prompts });
  });

  test('Stop frees the GPU and the spec removes everything it created', async ({ page }) => {
    test.setTimeout(20 * 60_000);
    await ensureExplorer(page);
    await callToolOk(page, 'local_llm_stop', {});
    await waitForPhase(page, (status) => !ACTIVE_PHASES.has(String(status.phase || 'idle')), { timeoutMs: 5 * 60_000, label: 'vLLM to stop' });
    expect(classifyComputeApps(await readComputeApps({}), state.box.id).owned, 'the Box holds no GPU compute process after Stop').toEqual([]);
    const deleted = await callTool(page, { tool: 'local_llm_weights_delete', args: { modelId: MODEL_ID, runnerId: VLLM } });
    expect(deleted.ok, deleted.text).toBe(true);
    const removed = await callTool(page, { tool: 'local_llm_model_remove', args: { modelId: MODEL_ID } });
    expect(removed.ok, removed.text).toBe(true);
    // The model is gone: a later failure must not make the afterAll retry its removal and skip the uninstall.
    state.modelAdded = false;
    if (state.installedBySpec) {
      const uninstalled = await callTool(page, { tool: 'local_llm_runner_uninstall', args: { runnerId: VLLM } });
      expect(uninstalled.ok, uninstalled.text).toBe(true);
    }
    await setSwitch(state.restoreSwitch);
    const after = await overview(page);
    expect(modelOf(after), 'the model must be gone').toBeNull();
    expect(runnerOf(after).enabled, `vLLM is ${state.restoreSwitch === 'experimental' ? 'enabled again, as before' : 'disabled again'} on unified memory`).toBe(state.restoreSwitch === 'experimental');
    if (state.installedBySpec) expect(runnerOf(after).installed).toBe(false);
    state.cleaned = true;
    const { paramSchema, ...runner } = runnerOf(after);
    writeEvidence(evidenceDir, '97-cleaned.json', { priorSwitch: state.priorSwitch, restoredSwitch: state.restoreSwitch, runner, modelPresent: Boolean(modelOf(after)) });
  });
});
