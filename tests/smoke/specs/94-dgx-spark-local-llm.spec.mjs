// DGX Spark local-llm inference (SMOKE_DGX_SPARK=1): the pinned small model on the CUDA llama.cpp runner, with every
// layer on the GB10, generating through the administrator test prompt, then stopped and its weights deleted.
//
//   1 a Run of qwen2.5-0.5b on llama.cpp reaches ready on CUDA0 (NVIDIA GB10) with all layers offloaded, as the Box user;
//   2 three test prompts return text at a positive generation rate while the runner is the only GPU compute process;
//   3 Stop frees the GPU and Delete removes the weights.
import path from 'node:path';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeArtifactPath, smokeConfig } from '../lib/config.mjs';
import {
  RUNNER_EXECUTABLE, SMALL_MODEL_COMMIT, SMALL_MODEL_ID, SMALL_MODEL_SHA256, SMALL_MODEL_SIZE, agentByRef, createHardwareApi, readRunnerProcesses,
} from '../lib/hardware-limits-evidence.mjs';
import {
  ACTIVE_PHASES, DGX_GPU, LOCAL_LLM_REF, UNIFIED_RUNNER,
  callTool, callToolOk, classifyComputeApps, createPloinky, dgxSparkEnabled, listNested, nestedNameOf, readComputeApps,
  requestId, requireDgxSparkEnvironment, resolveBox, restoreSteps, stopModelIfActive, waitForPhase, withAdminPage, writeEvidence,
  ensureExplorer,
} from '../lib/dgx-spark.mjs';

const evidenceDir = path.dirname(smokeArtifactPath('dgx-spark', '.keep'));
const MODEL_READY_MS = 30 * 60_000;
const PROMPTS = Object.freeze([
  'Write a numbered list of ten short facts about graphics cards.',
  'Explain unified memory in two sentences.',
  'Name three uses of a GPU.',
]);
const state = {};

test.describe('DGX Spark local-llm inference on the GB10 @dgx-spark', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!dgxSparkEnabled(), 'Set SMOKE_DGX_SPARK=1 to run the DGX Spark suite.');

  test.beforeAll(async () => {
    state.env = requireDgxSparkEnvironment();
    state.ploinky = createPloinky(state.env);
    state.box = await resolveBox({ ploinky: state.ploinky, workspaceRoot: state.env.workspaceRoot });
    state.localLlm = nestedNameOf(await listNested({ boxName: state.box.name }), LOCAL_LLM_REF);
  });

  // A failed test skips the rest of this serial block: stop the model and delete the weights it downloaded.
  test.afterAll(async ({ browser }) => {
    if (!state.modelStarted || state.cleaned) return;
    test.setTimeout(15 * 60_000);
    const restored = await withAdminPage(browser, smokeConfig.baseURL, (page) => restoreSteps([
      ['stop the model', () => stopModelIfActive(page).then((status) => status.phase)],
      ['delete the weights', () => callTool(page, { tool: 'local_llm_weights_delete', args: { modelId: SMALL_MODEL_ID, runnerId: UNIFIED_RUNNER } }).then((reply) => reply.ok || reply.text)],
    ]));
    writeEvidence(evidenceDir, '94-restore.json', restored);
  });

  test('the small model runs on CUDA llama.cpp with every layer on the GB10', async ({ page }) => {
    test.setTimeout(MODEL_READY_MS + 10 * 60_000);
    await ensureExplorer(page);
    const before = await stopModelIfActive(page);
    expect(before.profile, 'local-llm must run with the unified profile').toBe('unified');
    const foreign = classifyComputeApps(await readComputeApps({}), state.box.id).foreign;
    expect(foreign, `foreign GPU compute processes: ${JSON.stringify(foreign)}`).toEqual([]);

    state.modelStarted = true;
    const started = await callToolOk(page, 'local_llm_run', { requestId: requestId('run'), modelId: SMALL_MODEL_ID, runnerId: UNIFIED_RUNNER });
    expect(started.accepted).toBe(true);
    expect(started.deployment).toMatchObject({ modelId: SMALL_MODEL_ID, runnerId: UNIFIED_RUNNER, profile: 'unified' });
    expect(started.deployment.admission.status).toBe('ok');
    const ready = await waitForPhase(page, (status) => status.phase === 'ready' && status.deployment?.phase === 'ready', { timeoutMs: MODEL_READY_MS, label: `${SMALL_MODEL_ID} to be ready` });
    const deployment = ready.deployment;
    expect(deployment.artifact).toMatchObject({ sha256: SMALL_MODEL_SHA256, size: SMALL_MODEL_SIZE, commit: SMALL_MODEL_COMMIT });
    expect(ready.runnerReport.device).toBe(`CUDA0 (${DGX_GPU.name})`);
    expect(ready.runnerReport.offloaded.layers, 'every layer must be offloaded to the GB10').toBe(ready.runnerReport.offloaded.of);
    expect(ready.runnerReport.offloaded.of).toBeGreaterThan(0);
    expect(ready.memoryGuard?.samples, 'the unified memory guard samples while the model runs').toBeGreaterThan(0);
    expect(ready.memoryGuard.minAvailableBytes).toBeGreaterThan(ready.memoryGuard.floorBytes);

    // No GPU share is stored for local-llm, so the runner has no MPS environment (a share left by another spec would add one).
    const hardware = createHardwareApi({ request: page.request });
    const stored = agentByRef(await hardware.readOk(), LOCAL_LLM_REF);
    expect(stored, `${LOCAL_LLM_REF} must be in the hardware snapshot`).toBeTruthy();
    expect(stored.configured?.gpu, 'no GPU share may be stored for local-llm').toBeUndefined();

    const processes = await readRunnerProcesses({ boxName: state.box.name, agentName: state.localLlm });
    expect(processes.length, 'exactly one llama-server runs').toBe(1);
    expect(processes[0].exe).toBe(RUNNER_EXECUTABLE);
    expect(processes[0].uid, 'the runner runs as the Box user, never root').toEqual([1000, 1000, 1000, 1000]);
    expect(Object.keys(processes[0].cuda).filter((name) => name.startsWith('CUDA_MPS_')), 'no MPS share is stored, so none applies').toEqual([]);

    const apps = classifyComputeApps(await readComputeApps({}), state.box.id);
    expect(apps.foreign).toEqual([]);
    const runners = apps.owned.filter((app) => app.name.endsWith('/llama-server'));
    expect(runners.length, 'the host driver sees the runner as the Box\'s one GPU compute process').toBe(1);
    expect(runners[0].usedMiB).toBeGreaterThan(0);
    state.deploymentId = deployment.id;
    writeEvidence(evidenceDir, '94-ready.json', { deployment: { id: deployment.id, modelId: deployment.modelId, runnerId: deployment.runnerId, profile: deployment.profile, params: deployment.params, artifact: deployment.artifact, admission: deployment.admission }, runnerReport: ready.runnerReport, memoryGuard: ready.memoryGuard, runner: processes.map(({ pid, exe, uid }) => ({ pid, exe, uid })), gpuProcesses: apps.owned });
  });

  test('the administrator test prompt generates text on the GPU', async ({ page }) => {
    test.setTimeout(10 * 60_000);
    await ensureExplorer(page);
    const results = [];
    for (const prompt of PROMPTS) {
      const reply = await callToolOk(page, 'local_llm_test_prompt', { prompt, maxTokens: 256 });
      expect(reply.text.trim().length, `the model answered nothing to "${prompt}"`).toBeGreaterThan(0);
      expect(reply).toMatchObject({ modelId: SMALL_MODEL_ID, runnerId: UNIFIED_RUNNER, statsSource: 'runner timings' });
      expect(reply.completionTokens).toBeGreaterThan(0);
      expect(reply.generationTokensPerSecond).toBeGreaterThan(0);
      results.push({ prompt, chars: reply.text.length, completionTokens: reply.completionTokens, generationTokensPerSecond: reply.generationTokensPerSecond, promptTokensPerSecond: reply.promptTokensPerSecond, elapsedMs: reply.elapsedMs, finishReason: reply.finishReason });
    }
    const status = await callToolOk(page, 'local_llm_status', {});
    expect(status.phase).toBe('ready');
    expect(status.deployment.id, 'the model must not restart while it answers').toBe(state.deploymentId);
    expect(status.memoryGuard.minAvailableBytes).toBeGreaterThan(status.memoryGuard.floorBytes);
    writeEvidence(evidenceDir, '94-prompts.json', { results, memoryGuard: status.memoryGuard, lastCompletion: status.lastCompletion });
  });

  test('Stop frees the GPU and Delete removes the weights', async ({ page }) => {
    test.setTimeout(10 * 60_000);
    await ensureExplorer(page);
    await callToolOk(page, 'local_llm_stop', {});
    const stopped = await waitForPhase(page, (status) => !ACTIVE_PHASES.has(String(status.phase || 'idle')), { timeoutMs: 5 * 60_000, label: 'the model to stop' });
    expect(await readRunnerProcesses({ boxName: state.box.name, agentName: state.localLlm }), 'no runner after Stop').toEqual([]);
    const apps = classifyComputeApps(await readComputeApps({}), state.box.id);
    expect(apps.owned, 'the Box holds no GPU compute process after Stop').toEqual([]);
    const deleted = await callTool(page, { tool: 'local_llm_weights_delete', args: { modelId: SMALL_MODEL_ID, runnerId: UNIFIED_RUNNER } });
    expect(deleted.ok, deleted.text).toBe(true);
    const overview = await callToolOk(page, 'local_llm_overview', {});
    const model = overview.models.find((entry) => entry.id === SMALL_MODEL_ID);
    expect(model.weights.gguf.download.state, 'the weights must be gone').toBe('absent');
    state.cleaned = true;
    writeEvidence(evidenceDir, '94-stopped.json', { phase: stopped.phase, stopObservation: stopped.stopObservation, gpuProcesses: apps, weights: model.weights.gguf.download });
  });
});
