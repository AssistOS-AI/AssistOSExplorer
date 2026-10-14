// DGX Spark GPU revoke and grant (SMOKE_DGX_SPARK=1): the operator takes the GB10 away from local-llm, local-llm falls
// back to the CPU automatically and still serves the small model, and a grant restores the unified GPU profile.
// Each step replaces the Box generation, so this spec runs last.
//
//   1 `ploinky gpu revoke --agent local-llms/local-llm` leaves no GPU agent, no CDI request and the CPU profile;
//   2 the small model runs and answers on the CPU profile, then is stopped and deleted;
//   3 `ploinky gpu grant --agent local-llms/local-llm` restores the CDI request, the GB10 inside the agent and the
//     unified profile.
import path from 'node:path';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeArtifactPath, smokeConfig } from '../lib/config.mjs';
import { openExplorer } from '../lib/explorer.mjs';
import { SMALL_MODEL_ID, readRunnerProcesses, waitFor } from '../lib/hardware-limits-evidence.mjs';
import {
  ACTIVE_PHASES, CPU_RUNNER, DGX_GPU, GPU_CDI_DEVICE, LOCAL_LLM_REF, UNIFIED_RUNNER,
  callTool, callToolOk, classifyComputeApps, createCommandDevices, createPloinky, dgxSparkEnabled, execNested, inspectNested,
  listNested, nestedNameOf, parseGpuStatus, readComputeApps, requestId, requireDgxSparkEnvironment, resolveBox, restoreSteps,
  stopModelIfActive, waitForGraph, waitForPhase, withAdminPage, writeEvidence,
  ensureExplorer,
} from '../lib/dgx-spark.mjs';

const evidenceDir = path.dirname(smokeArtifactPath('dgx-spark', '.keep'));
const BOX_CHANGE_MS = 30 * 60_000;
const MODEL_READY_MS = 30 * 60_000;
const state = {};

test.describe('DGX Spark GPU revoke and grant for local-llm @dgx-spark', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!dgxSparkEnabled(), 'Set SMOKE_DGX_SPARK=1 to run the DGX Spark suite.');

  test.beforeAll(async () => {
    state.env = requireDgxSparkEnvironment();
    state.ploinky = createPloinky(state.env);
    state.box = await resolveBox({ ploinky: state.ploinky, workspaceRoot: state.env.workspaceRoot });
    state.graph = (await listNested({ boxName: state.box.name })).filter((entry) => entry.state === 'running').length;
  });

  // A failed test skips the rest of this serial block: never leave local-llm without its GPU, a model running, or a
  // runner this spec installed.
  test.afterAll(async ({ browser }) => {
    const steps = [];
    if (state.modelStarted && !state.cpuCleaned) {
      steps.push(['stop the CPU model and delete its weights', () => withAdminPage(browser, smokeConfig.baseURL, async (page) => {
        await stopModelIfActive(page);
        const deleted = await callTool(page, { tool: 'local_llm_weights_delete', args: { modelId: SMALL_MODEL_ID, runnerId: state.cpuRunnerId } });
        if (state.installedCpuRunner) await callTool(page, { tool: 'local_llm_runner_uninstall', args: { runnerId: CPU_RUNNER } });
        return deleted.ok || deleted.text;
      })]);
    }
    if (state.revoked && !state.granted) {
      steps.push(['grant local-llm its GPU again', async () => {
        const result = await state.ploinky(['gpu', 'grant', '--agent', LOCAL_LLM_REF], { timeoutMs: BOX_CHANGE_MS });
        if (result.status !== 0) throw new Error(`ploinky gpu grant exited ${result.status}: ${result.stderr.slice(-300)}`);
        return 'granted';
      }]);
    }
    if (steps.length) writeEvidence(evidenceDir, '96-restore.json', await restoreSteps(steps));
  });

  async function changeGpu(verb) {
    const started = Date.now();
    const result = await state.ploinky(['gpu', verb, '--agent', LOCAL_LLM_REF], { timeoutMs: BOX_CHANGE_MS });
    expect(result.status, `ploinky gpu ${verb} failed: ${result.stderr.slice(-800)}`).toBe(0);
    state.box = await resolveBox({ ploinky: state.ploinky, workspaceRoot: state.env.workspaceRoot });
    const running = await waitForGraph({ boxName: state.box.name, minimum: Math.max(state.graph, 16) });
    const nested = await listNested({ boxName: state.box.name });
    const name = nestedNameOf(nested, LOCAL_LLM_REF);
    const [record] = await inspectNested({ boxName: state.box.name, names: [name] });
    return { ms: Date.now() - started, gpu: parseGpuStatus((await state.ploinky(['gpu', 'status'], { timeoutMs: 60_000 })).stdout), running: running.length, name, record, tail: result.stdout.split('\n').slice(-6).join('\n') };
  }

  async function overviewWhenAnswering(page, accept) {
    return waitFor(async () => {
      try {
        const overview = await callToolOk(page, 'local_llm_overview', {});
        return accept(overview) ? overview : null;
      } catch { return null; }
    }, { timeoutMs: 5 * 60_000, intervalMs: 5000, label: 'local-llm to answer with the expected profile' });
  }

  test('revoking local-llm\'s GPU leaves no GPU agent and local-llm commits the CPU profile', async ({ page }) => {
    test.setTimeout(BOX_CHANGE_MS + 15 * 60_000);
    await ensureExplorer(page);
    await stopModelIfActive(page);
    state.initialGrant = parseGpuStatus((await state.ploinky(['gpu', 'status'], { timeoutMs: 60_000 })).stdout).grant;
    state.revoked = true;
    const change = await changeGpu('revoke');
    expect(change.gpu.agents, 'no agent may hold the GPU after the revoke').toEqual([]);
    expect(change.gpu.raw['GPU grant'] || '', 'the revoke is recorded for local-llm').toMatch(/local-llms\/local-llm/);
    expect(createCommandDevices(change.record.Config?.CreateCommand)).not.toContain(GPU_CDI_DEVICE);
    const gpuEnv = (change.record.Config?.Env || []).filter((entry) => entry.startsWith('PLOINKY_GPU_'));
    const smi = await execNested({ boxName: state.box.name, name: change.name, argv: ['sh', '-c', 'nvidia-smi -L 2>&1; test -e /dev/nvidia0 && echo has-dev || echo no-dev'] });
    expect(smi.stdout, 'the agent sees no NVIDIA device').toContain('no-dev');

    // The Box was replaced: navigate again for a session on the new Router (the first load finished long ago).
    await openExplorer(page);
    const overview = await overviewWhenAnswering(page, (value) => Boolean(value.profile));
    expect(overview.profile, 'without the GPU, local-llm falls back to the CPU automatically').toBe('cpu');
    expect(['absent', 'unusable']).toContain(overview.profileDecision.cause);
    state.cpuRunners = (overview.runners || []).map(({ id, supported, installed, enabled, reason }) => ({ id, supported, installed, enabled, reason }));
    writeEvidence(evidenceDir, '96-revoke.json', { box: { name: state.box.name, id: state.box.id, startedAt: state.box.startedAt }, initialGrant: state.initialGrant, ms: change.ms, gpuStatus: change.gpu.raw, gpuEnv, inside: smi.stdout.slice(0, 400), profile: overview.profile, profileDecision: overview.profileDecision, runners: state.cpuRunners });
  });

  test('the small model runs and answers on the CPU profile', async ({ page }) => {
    test.setTimeout(MODEL_READY_MS + 15 * 60_000);
    await ensureExplorer(page);
    const runners = Object.fromEntries(state.cpuRunners.map((runner) => [runner.id, runner]));
    let runnerId = UNIFIED_RUNNER;
    if (!(runners[UNIFIED_RUNNER]?.supported && runners[UNIFIED_RUNNER]?.installed)) {
      runnerId = CPU_RUNNER;
      expect(runners[CPU_RUNNER]?.supported, `the CPU profile must offer ${CPU_RUNNER}: ${JSON.stringify(runners[CPU_RUNNER])}`).toBe(true);
      if (!runners[CPU_RUNNER].installed) {
        const install = await callTool(page, { tool: 'local_llm_runner_install', args: { runnerId: CPU_RUNNER } });
        expect(install.ok, install.text).toBe(true);
        await waitFor(async () => {
          const overview = await callToolOk(page, 'local_llm_overview', {});
          return overview.runners.find((runner) => runner.id === CPU_RUNNER)?.installed ? overview : null;
        }, { timeoutMs: 15 * 60_000, intervalMs: 5000, label: `${CPU_RUNNER} to be installed` });
        state.installedCpuRunner = true;
      }
    }
    state.cpuRunnerId = runnerId;
    state.modelStarted = true;
    const started = await callToolOk(page, 'local_llm_run', { requestId: requestId('cpu-run'), modelId: SMALL_MODEL_ID, runnerId });
    expect(started.deployment.profile).toBe('cpu');
    const ready = await waitForPhase(page, (status) => status.phase === 'ready' && status.deployment?.phase === 'ready', { timeoutMs: MODEL_READY_MS, label: 'the model to be ready on the CPU' });
    expect(String(ready.runnerReport?.device || ''), 'nothing runs on a GPU').not.toMatch(/CUDA|GB10/);
    const reply = await callToolOk(page, 'local_llm_test_prompt', { prompt: 'Name three uses of a GPU.', maxTokens: 128 });
    expect(reply.text.trim().length).toBeGreaterThan(0);
    expect(reply.generationTokensPerSecond).toBeGreaterThan(0);
    const owned = classifyComputeApps(await readComputeApps({}), state.box.id).owned;
    expect(owned, 'a CPU run starts no GPU compute process').toEqual([]);
    await callToolOk(page, 'local_llm_stop', {});
    await waitForPhase(page, (status) => !ACTIVE_PHASES.has(String(status.phase || 'idle')), { timeoutMs: 5 * 60_000, label: 'the CPU model to stop' });
    const name = nestedNameOf(await listNested({ boxName: state.box.name }), LOCAL_LLM_REF);
    expect(await readRunnerProcesses({ boxName: state.box.name, agentName: name })).toEqual([]);
    const deleted = await callTool(page, { tool: 'local_llm_weights_delete', args: { modelId: SMALL_MODEL_ID, runnerId } });
    expect(deleted.ok, deleted.text).toBe(true);
    if (state.installedCpuRunner) {
      const removed = await callTool(page, { tool: 'local_llm_runner_uninstall', args: { runnerId: CPU_RUNNER } });
      expect(removed.ok, removed.text).toBe(true);
    }
    state.cpuCleaned = true;
    writeEvidence(evidenceDir, '96-cpu-run.json', { runnerId, installedCpuRunner: Boolean(state.installedCpuRunner), runnerReport: ready.runnerReport, prompt: { completionTokens: reply.completionTokens, generationTokensPerSecond: reply.generationTokensPerSecond, elapsedMs: reply.elapsedMs } });
  });

  test('granting the GPU back restores the GB10 and the unified profile', async ({ page }) => {
    test.setTimeout(BOX_CHANGE_MS + 15 * 60_000);
    const change = await changeGpu('grant');
    state.granted = true;
    expect(change.gpu.agents.map((agent) => agent.ref)).toEqual([LOCAL_LLM_REF]);
    // `gpu grant --agent` lifts the deny by recording an operator grant; plain `gpu grant` keeps a per-agent deny, so the
    // CLI cannot return to a manifest-only record. The end state is therefore always the explicit operator grant.
    expect(change.gpu.grant).toBe(`nvidia for ${LOCAL_LLM_REF}`);
    expect(change.gpu.agents[0].source).toBe('manifest + operator');
    expect(change.gpu.wiring).toBe('active');
    expect(createCommandDevices(change.record.Config?.CreateCommand)).toContain(GPU_CDI_DEVICE);
    expect(change.record.Config.Env).toContain('PLOINKY_GPU_STATUS=attached');
    const smi = await execNested({ boxName: state.box.name, name: change.name, argv: ['nvidia-smi', '--query-gpu=name,pci.device_id', '--format=csv,noheader'] });
    expect(smi.stdout.trim()).toBe(`${DGX_GPU.name}, ${DGX_GPU.pciDeviceId}`);
    await ensureExplorer(page);
    const overview = await overviewWhenAnswering(page, (value) => Boolean(value.profile));
    expect(overview.profile).toBe('unified');
    expect(overview.profileDecision).toMatchObject({ cause: 'gpu', gpuName: DGX_GPU.name });
    writeEvidence(evidenceDir, '96-grant.json', { box: { name: state.box.name, id: state.box.id, startedAt: state.box.startedAt }, initialGrant: state.initialGrant, ms: change.ms, gpuStatus: change.gpu.raw, profile: overview.profile, profileDecision: overview.profileDecision });
  });
});
