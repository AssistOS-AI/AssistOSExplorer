// E2E-D (release plan C2, C8): browser inference under limits on the apparatus GPU.
//
// Three tests, in order, on the gate-on E2E deployment:
//   1 the 4 CPU / 25 % RAM / 50 % GPU budget is applied through the Hardware limits panel, the small model runs on
//     llama.cpp, and the runner has exactly the three MPS variables of the saved share and one non-root user;
//   2 a Playground request (sustained load) answers inside measured windows: every CPU/RAM and GPU observation is
//     bound to its own request window (M-LLM-06), and the deployed analysis of the Ploinky clone decides;
//   3 the model is stopped, 4 % RAM is applied, and the next Run is refused before launch.
//
// The A5 idle gate (amendment A5) runs first and before every GPU observation: at most one recorded display process
// (type G, 64 MiB) is tolerated; any other foreign GPU process BLOCKS (the test fails, it never passes or skips).
// The saved 4 % override stays in place on purpose: E2E-E needs stored limits for the U9 refusal and clears them with
// `ploinky limits clear --all`. Evidence holds no cookies, CSRF values, environments or credentials.
import path from 'node:path';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig, smokeArtifactPath } from '../lib/config.mjs';
import { openExplorer } from '../lib/explorer.mjs';
import {
  INFERENCE_CADENCE,
  MIB,
  RUNNER_EXECUTABLE,
  SMALL_MODEL_COMMIT,
  SMALL_MODEL_ID,
  SMALL_MODEL_SHA256,
  SMALL_MODEL_SIZE,
  agentByRef,
  agentLeafPath,
  boxCgroupPrefix,
  checked,
  cpuMaxMatches,
  createEvidenceWriter,
  createHardwareApi,
  createHostObserver,
  createIdleGate,
  defaultRun,
  findMpsDaemons,
  findSingleInstanceAgent,
  gpuQueryArgv,
  hostRunnerIdentities,
  instanceByKey,
  loadDeployedAnalysis,
  measureInference,
  readHostGpuIdentity,
  readLeaf,
  readRunnerDigest,
  readRunnerProcesses,
  readRunningSet,
  refusalCode,
  requireHardwareEnvironment,
  resolveMemoryPercent,
  runnerIdentity,
  shareMemoryMiB,
  summarizeGpuCheck,
  waitFor,
} from '../lib/hardware-limits-evidence.mjs';

const AGENT_NAME = 'local-llm';
const AGENT_REF = `local-llms/${AGENT_NAME}`;
const RUNNER_ID = 'llama.cpp';
const BUDGET = Object.freeze({ cpus: 4, memoryPercent: 25, smPercent: 50, vramPercent: 50 });
const REFUSAL_MEMORY_PERCENT = 4;
const GIB = 1024 * MIB;
const MIN_BUDGET_RAM_BYTES = 3 * GIB;
// The tool's own bounds are 200 characters and 512 tokens; the longest answer makes a measurable window.
const PROMPT = 'Write a numbered list of forty short facts about graphics cards.';
const MAX_TOKENS = 512;
const APPLY_BOUND_MS = 5 * 60_000;
const MODEL_READY_BOUND_MS = 30 * 60_000;
const PROMPT_BOUND_MS = 5 * 60_000;
const SUSTAINED_MS = 60_000;
const MAX_REQUESTS = 8;
const ACTIVE_PHASES = new Set(['downloading', 'copying', 'verifying', 'pulling', 'starting', 'loading', 'ready', 'stopping']);

const evidence = createEvidenceWriter({ dir: path.dirname(smokeArtifactPath('hwl', '.keep')) });
const screenshot = (page, name) => page.screenshot({ path: smokeArtifactPath('hwl', 'screenshots', name), fullPage: false });
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The deployed Ploinky clone beside this checkout (the verifier layout `<smoke>/../../../ploinky`).
const ploinkyRoot = path.resolve(smokeConfig.repoRoot, '..', 'ploinky');

// State shared by the three serial tests.
const state = {};

test.describe('Local LLM Playground under hardware limits @hardware-limits', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!smokeConfig.flags.hardwareLimits, 'Set SMOKE_HARDWARE_LIMITS=1 to run the hardware-limits executors.');

  test.beforeAll(async () => {
    state.boxName = requireHardwareEnvironment().boxName;
    state.deployed = await loadDeployedAnalysis({ ploinkyRoot });
    state.observer = createHostObserver();
  });

  // ---- browser helpers ---------------------------------------------------

  async function openHardwareTab(page) {
    await openExplorer(page);
    await page.locator('#accountMenuButton').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    const dialog = page.locator('dialog.settings-modal-dialog');
    await expect(dialog).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
    const tab = dialog.getByRole('tab', { name: 'Hardware limits' });
    await expect(tab).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
    await tab.click();
    const section = dialog.locator('[data-section="hardware"]');
    await expect(section.locator('article.hardware-policy').first()).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
    return section;
  }

  const policyArticle = (page, section) => section.locator('article.hardware-policy')
    .filter({ has: page.locator('h3').filter({ hasText: new RegExp(`^${escapeRe(AGENT_REF)}$`) }) });

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
  }

  async function appliedSnapshot(api, key) {
    return waitFor(async () => {
      const snapshot = await api.readOk();
      const found = instanceByKey(snapshot, key);
      return found && found.instance.availability === 'ready' && found.instance.limitsState === 'applied' ? snapshot : null;
    }, { timeoutMs: APPLY_BOUND_MS, intervalMs: 2000, label: `${key} to be ready with applied limits` });
  }

  // The Local LLMs dashboard, through its toolbar entry (the expanded-modal descriptor of its config when the
  // toolbar has not mounted the entry).
  async function openDashboard(page) {
    await openExplorer(page);
    const button = page.locator('#localLlmToolButton');
    let via = 'toolbar-button';
    try {
      await expect(button).toBeVisible({ timeout: 15_000 });
      await button.click();
    } catch {
      via = 'expanded-modal';
      await page.evaluate(() => globalThis.assistOS.UI.openExpandedModal({ mode: 'component', component: 'local-llm-dashboard', title: 'Local LLMs' }));
    }
    const dashboard = page.locator('.local-llm-dashboard');
    await expect(dashboard).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
    await expect(dashboard.locator(`tr[data-model-id="${SMALL_MODEL_ID}"]`)).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
    return { dashboard, via };
  }

  // One tool call through the dashboard's own client (the transport of every dashboard action).
  async function callLocalLlm(page, tool, args = {}) {
    return page.evaluate(async ({ tool: name, args: input }) => {
      const client = globalThis.webSkel?.appServices?.getClient?.('local-llm');
      if (!client?.callTool) return { ok: false, text: 'The local-llm client is unavailable.' };
      const value = await client.callTool(name, input);
      const text = value?.content?.find?.((item) => item.type === 'text')?.text;
      if (value?.isError) return { ok: false, text: String(text || 'The tool failed.').slice(0, 800) };
      let result = value?.json && typeof value.json === 'object' ? value.json : undefined;
      if (result === undefined && text !== undefined) {
        try { result = JSON.parse(text); } catch { return { ok: false, text: String(text).slice(0, 800) }; }
      }
      if (result && result.ok === false) return { ok: false, text: JSON.stringify(result).slice(0, 800) };
      return { ok: true, result };
    }, { tool, args });
  }

  const statusOf = async (page) => {
    const reply = await callLocalLlm(page, 'local_llm_status', {});
    if (!reply.ok) throw new Error(`local_llm_status failed: ${reply.text}`);
    const status = reply.result;
    return { phase: String(status.phase || status.deployment?.phase || 'idle'), deployment: status.deployment || null };
  };

  // Records every local-llm tool call of the page with its own [sent, settled) interval.
  async function spyOnToolCalls(page) {
    await page.evaluate(() => {
      const client = globalThis.webSkel?.appServices?.getClient?.('local-llm');
      if (!client?.callTool) throw new Error('The local-llm client is unavailable.');
      if (client.hardwareSpyInstalled) return;
      globalThis.hardwareToolCalls = [];
      const original = client.callTool.bind(client);
      client.callTool = async (tool, args) => {
        const entry = { tool, sent: Date.now(), settled: null, isError: false, text: null };
        globalThis.hardwareToolCalls.push(entry);
        try {
          const value = await original(tool, args);
          entry.settled = Date.now();
          entry.isError = value?.isError === true;
          entry.text = String(value?.content?.find?.((item) => item.type === 'text')?.text || '').slice(0, 600);
          return value;
        } catch (error) {
          entry.settled = Date.now();
          entry.isError = true;
          entry.text = String(error?.message || error).slice(0, 600);
          throw error;
        }
      };
      client.hardwareSpyInstalled = true;
    });
  }

  async function selectModelAndRunner(page, dashboard) {
    await dashboard.locator(`tr[data-model-id="${SMALL_MODEL_ID}"]`).click();
    const form = dashboard.locator('#localLlmRunForm');
    await expect(form).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
    const runner = dashboard.locator('#localLlmRunner');
    await expect.poll(() => runner.evaluate((element) => element.value), { timeout: smokeConfig.timeouts.navigation }).not.toBe('');
    if (await runner.evaluate((element) => element.value) !== RUNNER_ID) {
      await runner.locator('.custom-select').click();
      await page.locator(`button.custom-select-option[data-value="${RUNNER_ID}"]`).click();
    }
    await expect.poll(() => runner.evaluate((element) => element.value)).toBe(RUNNER_ID);
    return form;
  }

  async function currentAgent(api) {
    const snapshot = await api.readOk();
    return { snapshot, ...findSingleInstanceAgent(snapshot, AGENT_NAME) };
  }

  async function gpuGate(boxName, uuid) {
    state.boxPrefix = await boxCgroupPrefix({ boxName, observer: state.observer });
    return createIdleGate({
      query: async () => checked(await defaultRun('nvidia-smi', gpuQueryArgv(uuid), { timeoutMs: 20_000 }), 'nvidia-smi inventory'),
      uuid,
      observer: state.observer,
      boxPrefix: state.boxPrefix,
    });
  }

  // Role-specific ownership (liveGpuGate): the Box's MPS control daemon (its server is the daemon's child in
  // <Box>/ploinky/core) and the exact agent leaf (every process inside it is a client of this test). Nothing else is owned.
  function registerOwners(containerId) {
    const daemons = findMpsDaemons({ observer: state.observer, boxPrefix: state.boxPrefix });
    expect(daemons.length, 'the Box must run its MPS control daemon once a GPU share is applied').toBeGreaterThanOrEqual(1);
    for (const daemon of daemons) state.gate.registerDaemon(daemon.hostPid);
    const leaf = agentLeafPath({ observer: state.observer, boxPrefix: state.boxPrefix, containerId });
    expect(leaf, `the cgroup leaf of ${containerId} must exist beneath the exact Box`).toBeTruthy();
    state.gate.registerLeaf(leaf);
    return { daemons: daemons.map((daemon) => daemon.hostPid), leaf };
  }

  // ---- 1 -----------------------------------------------------------------

  test('the 4 CPU / 25 % RAM / 50 % GPU budget is applied and the model runs with exactly the three MPS variables', async ({ page }) => {
    test.setTimeout(MODEL_READY_BOUND_MS + 3 * APPLY_BOUND_MS);
    const api = createHardwareApi({ request: page.request });
    state.api = api;
    const before = await api.readOk();
    const { gate: hardwareGate, gpu, envelope } = before;
    expect(hardwareGate.state, 'the hardware-limits gate must be on').toBe('on');
    expect(gpu.eligible, `MPS sharing must be eligible: ${String(gpu.reason || '').slice(0, 200)}`).toBe(true);
    expect(gpu.mode).toBe('mps-shared');
    expect(gpu.memoryModel).toBe('dedicated');
    expect(gpu.deviceUuid).toMatch(/^GPU-[a-fA-F0-9-]{8,64}$/);
    expect(Number.isSafeInteger(gpu.deviceMemoryBytes) && gpu.deviceMemoryBytes > 0).toBe(true);
    expect(envelope.cpus, 'the Box envelope must offer the budget CPUs').toBeGreaterThanOrEqual(BUDGET.cpus);
    const memoryBytes = resolveMemoryPercent(BUDGET.memoryPercent, envelope.memoryBytes);
    expect(memoryBytes, 'the budget RAM must cover the model and its 1 GiB margin').toBeGreaterThanOrEqual(MIN_BUDGET_RAM_BYTES);
    Object.assign(state, { uuid: gpu.deviceUuid, deviceMiB: gpu.deviceMemoryBytes / MIB, envelope, memoryBytes, shareMiB: shareMemoryMiB(BUDGET.vramPercent, gpu.deviceMemoryBytes / MIB) });

    // A5: the first gate check, before anything touches the GPU.
    state.gate = await gpuGate(state.boxName, state.uuid);
    const baseline = await state.gate.initial();
    evidence.write('91-a5-baseline.json', baseline);

    // The budget, through the administrator panel, applied to the exact instance.
    const { agent, instance } = await currentAgent(api);
    state.agent = agent;
    state.instanceKey = instance.key;
    await saveAndApply(page, { cpus: BUDGET.cpus, memoryPercent: BUDGET.memoryPercent, smPercent: BUDGET.smPercent, vramPercent: BUDGET.vramPercent }, instance.key);
    const applied = await appliedSnapshot(api, instance.key);
    const found = instanceByKey(applied, instance.key).instance;
    expect(agentByRef(applied, AGENT_REF).configured).toMatchObject({ cpus: BUDGET.cpus, memoryPercent: BUDGET.memoryPercent, gpu: { smPercent: BUDGET.smPercent, vramPercent: BUDGET.vramPercent } });
    expect(found.limits.cpu).toMatchObject({ cores: BUDGET.cpus, assurance: 'kernel' });
    expect(found.limits.memory).toMatchObject({ bytes: memoryBytes, assurance: 'kernel' });
    expect(found.limits.gpu).toMatchObject({ smPercent: BUDGET.smPercent, vramBytes: state.shareMiB * MIB, assurance: 'best-effort' });

    // Kernel readback of the exact new instance.
    const entry = (await readRunningSet({ boxName: state.boxName })).find((candidate) => candidate.name === instance.key);
    expect(entry, 'the applied instance must be in the nested running set').toBeTruthy();
    state.containerId = entry.id;
    const leaf = await readLeaf({ boxName: state.boxName, containerId: entry.id });
    expect(cpuMaxMatches(leaf.cpuMax, BUDGET.cpus), `cpu.max ${leaf.cpuMax} must be 4 CPUs (400000 or 399999 at period 100000)`).toBe(true);
    expect(leaf.memoryMax).toBe(String(memoryBytes));
    expect(leaf.swapMax, 'the swap cap must be exactly 0').toBe('0');
    evidence.write('91-budget-readback.json', { agent: AGENT_REF, instance: instance.key, budget: BUDGET, expectedMemoryBytes: memoryBytes, leaf: { path: leaf.leaf, cpuMax: leaf.cpuMax, memoryMax: leaf.memoryMax, swapMax: leaf.swapMax, pidsMax: leaf.pidsMax }, gpuShareMiB: state.shareMiB });

    // Run the small model on llama.cpp from the Local LLMs dashboard.
    state.owners = registerOwners(state.containerId);
    await state.gate.check('before-run', { minFreeMiB: state.shareMiB + 256 });
    const { dashboard, via } = await openDashboard(page);
    const form = await selectModelAndRunner(page, dashboard);
    await form.locator('[data-run-submit]').click();
    const deployment = await waitFor(async () => {
      const status = await statusOf(page);
      if (status.phase === 'error' || status.deployment?.phase === 'error') throw new Error(`The model run failed: ${String(status.deployment?.error || 'no error text').slice(0, 300)}`);
      return status.phase === 'ready' && status.deployment?.phase === 'ready' ? status.deployment : null;
    }, { timeoutMs: MODEL_READY_BOUND_MS, intervalMs: 3000, label: `${SMALL_MODEL_ID} on ${RUNNER_ID} to be ready` });
    expect(deployment.modelId).toBe(SMALL_MODEL_ID);
    expect(deployment.runnerId).toBe(RUNNER_ID);
    expect(deployment.artifact?.sha256, 'the model file digest must be the pinned one').toBe(SMALL_MODEL_SHA256);
    await screenshot(page, '91-model-ready.png');

    // The device: the Box's report agrees with the host driver's own.
    const hostGpu = await readHostGpuIdentity({ uuid: state.uuid });
    expect(hostGpu.uuid).toBe(gpu.deviceUuid);
    expect(hostGpu.driverVersion, 'the Box and the host driver must report one driver version').toBe(gpu.driverVersion);

    // The model artifact: the pinned file (digest, size and source commit).
    expect(deployment.artifact?.size, 'the model file size must be the pinned one').toBe(SMALL_MODEL_SIZE);
    expect(deployment.artifact?.commit, 'the model source commit must be the pinned one').toBe(SMALL_MODEL_COMMIT);

    // The runner: exactly the three MPS variables of the saved share, one non-root user, the same agent generation,
    // and the executable's own digest recorded from inside the agent.
    const share = { smPercent: BUDGET.smPercent, memory: `0=${state.shareMiB}M` };
    const processes = await readRunnerProcesses({ boxName: state.boxName, agentName: instance.key });
    expect(processes.length, 'a llama-server runner must run in the agent').toBeGreaterThanOrEqual(1);
    const identities = processes.map((processInfo) => runnerIdentity(processInfo, { share }));
    for (const identity of identities) expect(identity.problems, identity.problems.join('; ')).toEqual([]);
    for (const identity of identities) {
      expect(identity.identity.uid, 'the runner runs as the Box user').toBe(1000);
      expect(identity.identity.exe, 'the runner executable path').toBe(RUNNER_EXECUTABLE);
    }
    const runnerDigest = await readRunnerDigest({ boxName: state.boxName, agentName: instance.key });
    expect((await readRunningSet({ boxName: state.boxName })).find((candidate) => candidate.name === instance.key)?.id,
      'the agent must not restart while the model runs').toBe(entry.id);
    evidence.write('runner-identity.json', {
      openedVia: via,
      gpu: { uuid: gpu.deviceUuid, driverVersion: gpu.driverVersion, deviceMemoryBytes: gpu.deviceMemoryBytes, hostCrossCheck: hostGpu },
      model: { id: deployment.modelId, runner: deployment.runnerId, sha256: deployment.artifact.sha256, size: deployment.artifact.size, commit: deployment.artifact.commit },
      runnerExecutable: runnerDigest,
      share,
      owners: state.owners,
      runners: identities.map((identity) => identity.identity),
    });
  });

  // ---- 2 -----------------------------------------------------------------

  test('a Playground response arrives inside measured windows and the budget holds while it generates', async ({ page }) => {
    test.setTimeout(10 * 60_000);
    expect(state.containerId, 'test 1 must have started the model').toBeTruthy();
    const { dashboard } = await openDashboard(page);
    await spyOnToolCalls(page);
    const running = await statusOf(page);
    expect(running.phase, 'the model must still be running').toBe('ready');
    await dashboard.locator('[data-llm-tab="playground"]').click();
    const form = dashboard.locator('form[data-llm-form="prompt"]');
    await expect(form).toBeVisible();
    const result = form.locator('[data-llm-prompt-result]');

    // The runner's host identities and the first gate observations.
    const inner = await readRunnerProcesses({ boxName: state.boxName, agentName: state.instanceKey });
    const hostIdentities = hostRunnerIdentities({ inner, containerId: state.containerId, observer: state.observer });
    const hostPids = hostIdentities.map((entry) => entry.hostPid);
    state.owners = registerOwners(state.containerId);
    await state.gate.check('inference-start');

    // One Playground request through the UI; its exact interval is the one the browser's own tool call recorded.
    const request = async () => {
      const first = await page.evaluate(() => globalThis.hardwareToolCalls.length);
      await form.locator('textarea[name="prompt"]').fill(PROMPT);
      await form.locator('input[name="maxTokens"]').fill(String(MAX_TOKENS));
      await result.evaluate((element) => element.replaceChildren());
      const answered = result.evaluate((element) => new Promise((resolve) => {
        const done = () => element.querySelector('pre.local-llm-answer');
        if (done()) { resolve(done().textContent); return; }
        const observer = new MutationObserver(() => { if (done()) { observer.disconnect(); resolve(done().textContent); } });
        observer.observe(element, { childList: true, subtree: true });
      }));
      await form.locator('[data-llm-send]').click();
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The Playground did not answer in time.')), PROMPT_BOUND_MS); });
      const text = String(await Promise.race([answered, timeout]).finally(() => clearTimeout(timer)));
      const call = await page.evaluate((index) => globalThis.hardwareToolCalls.slice(index).find((entry) => entry.tool === 'local_llm_test_prompt') || null, first);
      if (!call || call.settled === null) throw new Error('The browser recorded no completed local_llm_test_prompt call.');
      if (call.isError) throw new Error(`The Playground request was refused: ${call.text}`);
      const meta = await result.locator('.settings-card-meta').first().innerText().catch(() => '');
      return {
        text: text === '(empty answer)' ? '' : text,
        completionTokens: Number((/([0-9]+) tokens in/.exec(meta) || [])[1]) || 0,
        window: { sent: call.sent, settled: call.settled },
      };
    };

    const measured = await measureInference({
      request,
      classify: state.deployed.classifyObservation,
      sampleLeaf: () => readLeaf({ boxName: state.boxName, containerId: state.containerId }),
      sampleGpu: async (label) => summarizeGpuCheck(label, await state.gate.check(label), hostPids),
      sampleMs: INFERENCE_CADENCE.sampleMs,
      gpuMs: INFERENCE_CADENCE.gpuMs,
      sustainedMs: SUSTAINED_MS,
      maxRequests: MAX_REQUESTS,
    });

    // The evidence first; the analysis decides after.
    const lost = hostIdentities.filter((entry) => {
      const now = state.observer.observe(entry.hostPid);
      return !now || now.startIdentity !== entry.startIdentity || now.bootId !== entry.bootId;
    }).map((entry) => `The runner host process ${entry.hostPid} no longer has its recorded identity.`);
    const analysis = state.deployed.analyzeInference({
      cgroup: measured.cgroup,
      gpu: measured.gpu,
      cpus: BUDGET.cpus,
      memoryCapBytes: state.memoryBytes,
      shareMiB: state.shareMiB,
    });
    const violations = [...analysis.violations, ...lost, ...(measured.load.invalidResponses > 0 ? [`${measured.load.invalidResponses} later response(s) of the sustained load carried no text`] : [])];
    const trim = (samples) => (samples.length <= 120 ? samples : [...samples.slice(0, 60), ...samples.slice(-60)]);
    evidence.write('91-inference.json', { runner: hostIdentities, windowMs: measured.windowMs, load: measured.load, requestWindows: measured.windows.slice(0, 120), cgroupSamples: trim(measured.cgroup), gpuSamples: trim(measured.gpu), failure: measured.failure ? String(measured.failure.message).slice(0, 300) : null });
    evidence.write('analysis.json', { violations, blockers: analysis.blockers, summary: analysis.summary });
    evidence.write('91-response.json', { text: String(measured.kept?.text || '').slice(0, 400), completionTokens: measured.kept?.completionTokens ?? null });
    await screenshot(page, '91-playground-response.png');

    expect(measured.failure, `the measured run failed: ${String(measured.failure?.message || '')}`).toBeNull();
    expect(typeof measured.kept?.text === 'string' && measured.kept.text.trim().length > 0, 'the model returned no text').toBe(true);
    expect(violations, `the budget was not held while the model generated: ${violations.join('; ')}`).toEqual([]);
    expect(analysis.blockers, `the inference could not be measured: ${analysis.blockers.join('; ')}`).toEqual([]);
    expect(analysis.summary.samples.inFlightCgroup).toBeGreaterThanOrEqual(3);
    expect(analysis.summary.samples.inFlightGpu).toBeGreaterThanOrEqual(2);
    expect(analysis.summary.memory.oomKillDelta ?? 0, 'no OOM kill during the window').toBe(0);
    expect(analysis.summary.memory.swapMaxSeenBytes, 'no swap during the window').toBe(0);
  });

  // ---- 3 -----------------------------------------------------------------

  test('after the model is stopped and 4 % RAM is applied, a Run is refused before launch', async ({ page, browser }) => {
    test.setTimeout(MODEL_READY_BOUND_MS);
    const api = state.api || createHardwareApi({ request: page.request });
    const { dashboard } = await openDashboard(page);
    await dashboard.locator('[data-llm-stop]').click();
    await waitFor(async () => !ACTIVE_PHASES.has((await statusOf(page)).phase), { timeoutMs: 5 * 60_000, intervalMs: 2000, label: 'the model to stop' });
    await state.gate.check('after-stop');

    // 4 % RAM on the saved CPU and GPU budget, applied to the exact instance.
    await saveAndApply(page, { memoryPercent: REFUSAL_MEMORY_PERCENT }, state.instanceKey);
    const applied = await appliedSnapshot(api, state.instanceKey);
    const memoryBytes = resolveMemoryPercent(REFUSAL_MEMORY_PERCENT, applied.envelope.memoryBytes);
    expect(instanceByKey(applied, state.instanceKey).instance.limits.memory).toMatchObject({ bytes: memoryBytes, assurance: 'kernel' });
    const entry = (await readRunningSet({ boxName: state.boxName })).find((candidate) => candidate.name === state.instanceKey);
    expect(entry, 'the replaced instance must run').toBeTruthy();
    const leaf = await readLeaf({ boxName: state.boxName, containerId: entry.id });
    expect(leaf.memoryMax, 'the replacement cap must be the 4 % cap').toBe(String(memoryBytes));
    expect(leaf.swapMax).toBe('0');

    // The Run, in its own signed-in context: a refusal may log browser errors, which must not hide the real assertion.
    const context = await browser.newContext({ baseURL: smokeConfig.baseURL, ignoreHTTPSErrors: true });
    let refusal;
    try {
      const other = await context.newPage();
      const opened = await openDashboard(other);
      await spyOnToolCalls(other);
      const form = await selectModelAndRunner(other, opened.dashboard);
      await form.locator('[data-run-submit]').click();
      const call = await waitFor(async () => other.evaluate(() => globalThis.hardwareToolCalls.find((candidate) => candidate.tool === 'local_llm_run' && candidate.settled !== null) || null),
        { timeoutMs: 2 * 60_000, intervalMs: 500, label: 'the Run request to settle' });
      expect(call.isError, 'the Run must be refused').toBe(true);
      const code = refusalCode(call.text);
      await expect(other.locator('#localLlmStatus'), 'the refusal reason must be visible').toContainText(/\S/, { timeout: smokeConfig.timeouts.navigation });
      await screenshot(other, '91-run-refused.png');
      const status = await statusOf(other);
      refusal = { code, message: String(call.text).slice(0, 400), phase: status.phase, deployment: status.deployment ? { id: status.deployment.id ?? null, phase: status.deployment.phase ?? null } : null };
    } finally {
      await context.close();
    }
    // Refused BEFORE launch: no runner process, no active deployment, no other identity created.
    const runners = await readRunnerProcesses({ boxName: state.boxName, agentName: state.instanceKey });
    evidence.write('refusal.json', { ...refusal, runnerProcesses: runners.length, memoryMax: leaf.memoryMax });
    expect(refusal.code, 'the typed refusal code').toBe('admission_insufficient_now');
    expect(runners.length, 'no runner process may exist after a refused Run').toBe(0);
    expect(ACTIVE_PHASES.has(refusal.phase), `no deployment may be active after a refused Run (phase ${refusal.phase})`).toBe(false);
  });
});
