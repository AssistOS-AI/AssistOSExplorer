// local-llm model registries (SMOKE_LOCAL_LLM_REGISTRIES=1): the credential store, the registry kinds and the snapshot
// path of the local-llm agent, end to end on a live Box, through the Explorer administrator and the Router.
//
//   credentials       the generated key reaches the agent (A32), a dummy credential is stored, survives a proven
//                     local-llm restart (N3) and leaks nowhere;
//   negative controls four refusals with their typed error codes;
//   GGUF              four GGUF models (Docker Hub CNCF and legacy, ModelScope, a self-registered Hugging Face
//                     registry) are looked up, added, run on the CUDA llama.cpp, prompted, stopped and deleted;
//   snapshot          vLLM is installed at the pinned version and runs an OCI and a ModelScope safetensors snapshot;
//   final restore     every group restored what it created, and the registry state files match the initial record.
// The tests are declared from SPEC98_INVENTORY, so the runner's judgement and this file cannot drift. The file-level
// beforeAll is read-only and idempotent, because Playwright runs it again in every new worker after a failure.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { nestedArgs, waitFor } from '../lib/hardware-limits-evidence.mjs';
import {
  callTool, callToolOk, classifyComputeApps, createPloinky, ensureExplorer, execNested, inspectNested, listNested, nestedNameOf,
  readComputeApps, requestId, restoreSteps, runCommand, stopModelIfActive, withAdminPage, writeEvidence,
} from '../lib/dgx-spark.mjs';
import {
  SPEC98_INVENTORY, assertBaseUrlBindsBox, classifyKeyProbe, locateBox, requireLocalLlmRegistriesEnvironment, stateFileRestoreStep,
  toolErrorCode,
} from '../lib/local-llm-registries.mjs';

const evidenceDir = smokeConfig.artifactRoot;
const LOCAL_LLM_REF = 'local-llms/local-llm';
const GGUF_RUNNER = 'llama.cpp';
const VLLM = 'vllm';
const MODEL_READY_MS = 30 * 60_000;
const INSTALL_MS = 30 * 60_000;
const STATE_FILES = Object.freeze({ registries: '/data/state/registries.json', credentials: '/data/state/registry-credentials.json' });
const KEY_PROBE = 'k="${LOCAL_LLM_CREDENTIALS_KEY-}"; [ -n "$k" ] || exit 3; case "$k" in *[!0-9a-f]*) exit 4;; esac; [ ${#k} -eq 64 ] || exit 4; exit 0';
const PROMPTS = Object.freeze(['Name three uses of a GPU.', 'Explain what a package registry is in two sentences.', 'Write a haiku about a datacenter.']);
const GGUF_REPO = 'Qwen/Qwen2.5-0.5B-Instruct-GGUF';
const GGUF_FILE = 'qwen2.5-0.5b-instruct-q4_k_m.gguf';
const state = { partials: [], rateLimits: [] };

test.skip(!smokeConfig.flags.localLlmRegistries, 'Set SMOKE_LOCAL_LLM_REGISTRIES=1 (through npm run test:local-llm-registries) to run the registries suite.');

// ---------------------------------------------------------------------------
// Inventory

const titleOf = (group, index) => {
  const found = SPEC98_INVENTORY.filter((entry) => entry.group === group)[index];
  if (!found) throw new Error(`SPEC98_INVENTORY has no test ${index} in the group ${group}.`);
  return found.title;
};
const declare = (group, index, body) => test(titleOf(group, index), body);

// ---------------------------------------------------------------------------
// Helpers on the live deployment

const exec = (argv, timeoutMs = 60_000) => execNested({ boxName: state.box.name, name: state.localLlm, argv, timeoutMs });
const evidence = (name, value) => writeEvidence(evidenceDir, name, value);

// `test -e` / `test -d` in the local-llm container: exit 1 is absent, 0 is present, anything else aborts (N1).
async function exists(file, flag = '-e') {
  const result = await exec(['test', flag, file]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`test ${flag} ${file} in the local-llm container exited ${result.status}${result.signal ? ` (${result.signal})` : ''}: cannot tell present from absent.`);
}

const registryList = (page) => callToolOk(page, 'local_llm_registry_list', {});
const credentialOf = (list, id) => (list.registries.find((entry) => entry.id === id) || {}).credential;
const overview = (page) => callToolOk(page, 'local_llm_overview', {});

async function assertRegistryAbsent(page, id) {
  const list = await registryList(page);
  if (list.registries.some((entry) => entry.id === id)) throw new Error(`The registry ${id} already exists: remove it (local_llm_registry_remove) before this run; the suite touches only what it creates.`);
}

async function saveRegistry(page, group, registry) {
  await callToolOk(page, 'local_llm_registry_save', { registry });
  group.created.push(registry.id);
}

async function startedAtOf() {
  const [record] = await inspectNested({ boxName: state.box.name, names: [state.localLlm] });
  const startedAt = record?.State?.StartedAt;
  if (!startedAt) throw new Error('The nested local-llm container reports no State.StartedAt.');
  return startedAt;
}

async function localLlmAnswers(page) {
  return waitFor(async () => {
    const reply = await callTool(page, { tool: 'local_llm_overview', args: {} }).catch(() => null);
    return reply?.ok ? reply.value : null;
  }, { timeoutMs: 5 * 60_000, intervalMs: 5000, label: 'local-llm to answer' });
}

// Docker Hub's anonymous pull budget, read from the ratelimitpreview repository. Failures are recorded, never thrown.
async function dockerHubRateLimit(label) {
  const entry = { label, at: new Date().toISOString() };
  try {
    const tokenReply = await fetch('https://auth.docker.io/token?service=registry.docker.io&scope=repository:ratelimitpreview/test:pull', { signal: AbortSignal.timeout(20_000) });
    const bearer = (await tokenReply.json())?.token;
    const head = await fetch('https://registry-1.docker.io/v2/ratelimitpreview/test/manifests/latest', {
      method: 'HEAD', headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(20_000),
    });
    Object.assign(entry, { status: head.status, remaining: head.headers.get('ratelimit-remaining'), limit: head.headers.get('ratelimit-limit') });
  } catch (error) {
    entry.error = String(error?.message || error).slice(0, 200);
  }
  state.rateLimits.push(entry);
  evidence('dockerhub-ratelimit.json', state.rateLimits);
}

// ---------------------------------------------------------------------------
// Groups: what each created, and its restore

function newGroup(name) {
  return { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), created: [], credentials: [], models: [], installedVllm: false };
}
const groups = Object.fromEntries(['credentials', 'negative controls', 'GGUF', 'snapshot'].map((name) => [name, newGroup(name)]));

async function weightsAbsent(page, model) {
  const found = ((await overview(page)).models || []).find((entry) => entry.id === model.id);
  return !found || found.weights?.[model.format]?.download?.state === 'absent';
}

// Stops the runner, deletes weights and removes the group's models, clears its credentials, removes its registries (and
// uninstalls vLLM when the group installed it), then writes restore-<group>.json even when there is nothing to undo.
async function restoreGroup(browser, group) {
  test.setTimeout(45 * 60_000);
  const must = async (page, tool, args) => {
    const reply = await callTool(page, { tool, args });
    if (!reply.ok) throw new Error(`${tool} failed: ${reply.text.slice(0, 300)}`);
    return tool;
  };
  const steps = [['stop the runner', (page) => stopModelIfActive(page).then((status) => status.phase)]];
  for (const model of [...group.models].reverse()) {
    if (!model.weightsDeleted) {
      steps.push([`delete the weights of ${model.id}`, async (page) => {
        const reply = await callTool(page, { tool: 'local_llm_weights_delete', args: { modelId: model.id, runnerId: model.runnerId } });
        if (!reply.ok && !(await weightsAbsent(page, model))) throw new Error(`local_llm_weights_delete failed: ${reply.text.slice(0, 300)}`);
        return reply.ok ? 'deleted' : 'already absent';
      }]);
    }
    if (!model.removed) steps.push([`remove the model ${model.id}`, (page) => must(page, 'local_llm_model_remove', { modelId: model.id })]);
  }
  for (const id of [...group.credentials].reverse()) steps.push([`clear the credential of ${id}`, (page) => must(page, 'local_llm_registry_credential_clear', { id })]);
  if (group.installedVllm) steps.push(['uninstall the vLLM this group installed', (page) => must(page, 'local_llm_runner_uninstall', { runnerId: VLLM })]);
  for (const id of [...group.created].reverse()) steps.push([`remove the registry ${id}`, (page) => must(page, 'local_llm_registry_remove', { id })]);
  let results;
  try {
    results = await withAdminPage(browser, smokeConfig.baseURL, (page) => restoreSteps(steps.map(([label, step]) => [label, () => step(page)])));
  } catch (error) {
    results = [{ label: 'open an administrator page', ok: false, detail: String(error?.message || error).slice(0, 400) }];
  }
  evidence(`restore-${group.slug}.json`, results);
}

// ---------------------------------------------------------------------------
// Model flows

const sha256Of = (file) => crypto.createHash('sha256').update(file).digest('hex');

function modelEntry({ id, displayName, lookup, source, format }) {
  return {
    id, displayName,
    ...(lookup.license ? { license: lookup.license } : {}),
    ...(lookup.sizing?.architecture ? { architecture: lookup.sizing.architecture } : {}),
    ...(Number.isInteger(lookup.sizing?.contextLength) ? { contextLength: lookup.sizing.contextLength } : {}),
    ...(lookup.sizing?.source ? { sizingSource: lookup.sizing.source } : {}),
    ...(lookup.sizing?.memory ? { memory: lookup.sizing.memory } : {}),
    sources: { [format]: source },
  };
}

const ociStoreDir = (root, source) => {
  const segments = source.repository.split('/');
  return `/data/models/${root}/_oci/${source.registry}/${[...segments.slice(0, -1), `${segments.at(-1)}@sha256-${source.manifestDigest.replace(/^sha256:/, '')}`].join('/')}`;
};
const mirrorStoreDir = (root, source) => `/data/models/${root}/_r/${source.registry}/${source.repo}/${source.commit || source.revision}`;
const storeDirOf = (format, source) => {
  const root = format === 'gguf' ? 'gguf' : 'hf';
  return source.type === 'oci' || source.type === 'oci-snapshot' ? ociStoreDir(root, source) : mirrorStoreDir(root, source);
};

async function recordPrompts(page, model) {
  const answers = [];
  for (const prompt of PROMPTS) {
    const reply = await callToolOk(page, 'local_llm_test_prompt', { prompt, maxTokens: 128 });
    expect(reply.text.trim().length, `${model.id} answered nothing to "${prompt}"`).toBeGreaterThan(0);
    answers.push({ prompt, answer: reply.text.slice(0, 400).replace(/csrf|cookie|password|authorization|bearer/gi, '[word]'), completionTokens: reply.completionTokens, elapsedMs: reply.elapsedMs, generationTokensPerSecond: reply.generationTokensPerSecond });
  }
  return answers;
}

// Lookup, Add and the foreign compute-app check, shared by the GGUF and the snapshot tests.
async function lookupAndAdd(page, group, def) {
  await ensureExplorer(page);
  await stopModelIfActive(page);
  const before = await overview(page);
  expect((before.models || []).find((entry) => entry.id === def.id) || null, `${def.id} is left over from an interrupted run`).toBeNull();
  const lookup = await callToolOk(page, 'local_llm_model_lookup', def.lookup);
  const source = def.source(lookup);
  const added = await callToolOk(page, 'local_llm_model_add', { model: modelEntry({ id: def.id, displayName: def.displayName, lookup, source, format: def.format }) });
  const model = { id: def.id, runnerId: def.runnerId, format: def.format, weightsDeleted: false, removed: false };
  group.models.push(model);
  const pinned = added.model.sources[def.format];
  evidence(`${def.slug}-source.json`, { lookup: { registry: lookup.registry, provider: lookup.provider, commit: lookup.commit, manifestDigest: lookup.manifestDigest ?? null, layout: lookup.layout ?? null, files: lookup.files?.length, sizing: lookup.sizing }, pinned });
  return { lookup, pinned, model };
}

async function foreignComputeApps(model) {
  const foreign = classifyComputeApps(await readComputeApps({}), state.box.id).foreign;
  expect(foreign, `foreign GPU compute processes before running ${model.id}: ${JSON.stringify(foreign)}`).toEqual([]);
}

// Stop, Delete weights, the store directory check and Remove.
async function finishModel(page, def, { pinned, model, partial = false }) {
  await callTool(page, { tool: 'local_llm_stop', args: {} });
  await stopModelIfActive(page);
  const dir = storeDirOf(def.format, pinned);
  const hadDirectory = await exists(dir);
  const deleted = await callToolOk(page, 'local_llm_weights_delete', { modelId: model.id, runnerId: model.runnerId });
  model.weightsDeleted = true;
  if (def.format === 'gguf') expect(deleted.freedBytes, 'Delete weights frees exactly the pinned size').toBe(pinned.size);
  else if (!partial) expect(deleted.freedBytes, 'Delete weights frees at least the pinned size').toBeGreaterThanOrEqual(pinned.size);
  const gone = !(await exists(dir));
  if (!partial || hadDirectory) expect({ hadDirectory, gone }, `the store directory ${dir} existed before Delete weights and is gone after`).toEqual({ hadDirectory: true, gone: true });
  await callToolOk(page, 'local_llm_model_remove', { modelId: model.id });
  model.removed = true;
  return { storeDir: dir, hadDirectory, gone, freedBytes: deleted.freedBytes, pinnedSize: pinned.size };
}

async function waitUntilReady(page, label) {
  const deadline = Date.now() + MODEL_READY_MS;
  let lastPhase = 'idle';
  for (;;) {
    const status = await callToolOk(page, 'local_llm_status', {});
    const phase = String(status.phase || 'idle');
    if (status.phase === 'ready' && status.deployment?.phase === 'ready') return { ready: status };
    if (phase === 'error' || status.deployment?.phase === 'error') return { failed: { phase: lastPhase, reason: String(status.deployment?.error || '').slice(0, 400) } };
    lastPhase = phase;
    if (Date.now() >= deadline) return { failed: { phase: lastPhase, reason: `timed out waiting for ${label}` } };
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

function notePartial(entry) {
  state.partials.push(entry);
  evidence('partial-snapshot.json', state.partials);
  test.info().annotations.push({ type: 'partial', description: `${entry.modelId}: ${entry.reason}` });
}

const GGUF_DEFS = () => [
  {
    key: 'oci-cncf', slug: 'gguf-oci-cncf', id: `reg-oci-cncf-${state.run}`, displayName: 'SmolLM2 135M (Docker Hub CNCF, E2E)',
    lookup: { registry: 'dockerhub', repo: 'ai/smollm2', revision: '135m-q4_K_M', format: 'gguf' },
    source: (lookup) => ({ type: 'oci', registry: 'dockerhub', repository: 'ai/smollm2', tag: '135m-q4_K_M', file: lookup.files[0].file }),
  },
  {
    key: 'oci-legacy', slug: 'gguf-oci-legacy', id: `reg-oci-legacy-${state.run}`, displayName: 'SmolLM2 (Docker Hub legacy, E2E)',
    lookup: { registry: 'dockerhub', repo: 'ai/smollm2', revision: 'latest', format: 'gguf' },
    source: (lookup) => ({ type: 'oci', registry: 'dockerhub', repository: 'ai/smollm2', tag: 'latest', file: lookup.files[0].file }),
  },
  {
    key: 'modelscope', slug: 'gguf-modelscope', id: `reg-ms-gguf-${state.run}`, displayName: 'Qwen2.5 0.5B Instruct (ModelScope, E2E)',
    lookup: { registry: 'modelscope', repo: GGUF_REPO, format: 'gguf', file: GGUF_FILE },
    source: (lookup) => ({ type: 'huggingface', registry: 'modelscope', repo: GGUF_REPO, file: GGUF_FILE, revision: lookup.commit }),
  },
  {
    key: 'hf-self', slug: 'gguf-hf-self', id: `reg-hf-self-${state.run}`, displayName: 'Qwen2.5 0.5B Instruct (self-registered Hugging Face, E2E)',
    lookup: { registry: `hf-self-${state.run}`, repo: GGUF_REPO, revision: 'main', format: 'gguf', file: GGUF_FILE },
    source: (lookup) => ({ type: 'huggingface', registry: `hf-self-${state.run}`, repo: GGUF_REPO, file: GGUF_FILE, revision: lookup.commit }),
  },
].map((def) => ({ ...def, format: 'gguf', runnerId: GGUF_RUNNER }));

const SNAPSHOT_DEFS = () => [
  {
    key: 'oci-snapshot', slug: 'snapshot-oci', id: `reg-oci-snap-${state.run}`, displayName: 'SmolLM2 135M safetensors (Docker Hub, E2E)',
    lookup: { registry: 'dockerhub', repo: 'ai/smollm2', revision: '135m-safetensors', format: 'hf' },
    source: () => ({ type: 'oci-snapshot', registry: 'dockerhub', repository: 'ai/smollm2', tag: '135m-safetensors' }),
  },
  {
    key: 'hf-snapshot', slug: 'snapshot-modelscope', id: `reg-ms-snap-${state.run}`, displayName: 'Qwen2.5 0.5B Instruct (ModelScope snapshot, E2E)',
    lookup: { registry: 'modelscope', repo: 'Qwen/Qwen2.5-0.5B-Instruct', format: 'hf' },
    source: (lookup) => ({ type: 'hf-snapshot', registry: 'modelscope', repo: 'Qwen/Qwen2.5-0.5B-Instruct', revision: lookup.commit }),
  },
].map((def) => ({ ...def, format: 'hf', runnerId: VLLM }));

// ---------------------------------------------------------------------------
// Setup

test.beforeAll(async ({ browser }) => {
  state.env = requireLocalLlmRegistriesEnvironment();
  state.ploinky = createPloinky(state.env);
  state.box = await locateBox({ ploinky: state.ploinky, workspaceRoot: state.env.workspaceRoot });
  state.baseUrlComparison = assertBaseUrlBindsBox({ baseURL: state.env.baseURL, box: state.box });
  console.log(`[spec 98] base URL check: expected ${state.baseUrlComparison.expected}; current ${state.baseUrlComparison.current.join(', ')}; ok ${state.baseUrlComparison.ok}; Box ${state.box.name} resolved by ${state.box.resolvedBy}`);
  state.localLlm = nestedNameOf(await listNested({ boxName: state.box.name }), LOCAL_LLM_REF);
  // Every worker of one run derives the same ids: 6 hex characters of sha256(SMOKE_RUN_ID).
  state.run = sha256Of(smokeConfig.runId).slice(0, 6);
  const initialFile = path.join(evidenceDir, 'initial-registries.json');
  if (fs.existsSync(initialFile)) {
    state.initial = JSON.parse(fs.readFileSync(initialFile, 'utf8'));
  } else {
    const list = await withAdminPage(browser, smokeConfig.baseURL, (page) => registryList(page));
    const files = {};
    for (const [name, file] of Object.entries(STATE_FILES)) files[name] = await exists(file);
    state.initial = {
      runId: smokeConfig.runId, resolvedBy: state.box.resolvedBy, baseUrlComparison: state.baseUrlComparison,
      registries: list.registries.map((entry) => ({ id: entry.id, kind: entry.kind, enabled: entry.enabled, builtIn: entry.builtIn === true, credential: entry.credential })),
      files,
    };
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(initialFile, `${JSON.stringify(state.initial, null, 2)}\n`, { flag: 'wx' });
  }
});

// ---------------------------------------------------------------------------
// credentials

test.describe('credentials', () => {
  test.describe.configure({ mode: 'serial' });
  const group = groups.credentials;
  const registryId = () => `oci-dummy-${state.run}`;

  test.beforeAll(async ({ browser }) => {
    await withAdminPage(browser, smokeConfig.baseURL, (page) => assertRegistryAbsent(page, registryId()));
  });
  test.afterAll(async ({ browser }) => { await restoreGroup(browser, group); });

  declare('credentials', 0, async ({ page }) => {
    test.setTimeout(5 * 60_000);
    // Only the exit code of the probe leaves the container; the key never does.
    const probe = await exec(['sh', '-c', KEY_PROBE]);
    const keyProbeExit = typeof probe.status === 'number' ? probe.status : null;
    evidence('a32.json', { keyProbeExit, keyProbe: classifyKeyProbe(keyProbeExit) });
    await ensureExplorer(page);
    const list = await registryList(page);
    evidence('a32-storage.json', { credentialStorage: list.credentialStorage });
    expect(list.credentialStorage.available, `credential storage is unavailable: ${list.credentialStorage.reason}`).toBe(true);
  });

  declare('credentials', 1, async ({ page }) => {
    test.setTimeout(5 * 60_000);
    await ensureExplorer(page);
    await assertRegistryAbsent(page, registryId());
    await saveRegistry(page, group, { id: registryId(), kind: 'oci', url: 'https://registry.invalid', label: 'Dummy OCI registry (E2E)' });
    state.dummy = `dummy-${crypto.randomUUID()}`;
    const set = await callToolOk(page, 'local_llm_registry_credential_set', { id: registryId(), token: state.dummy });
    group.credentials.push(registryId());
    expect(set).toMatchObject({ id: registryId(), credential: 'set' });
    const list = await registryList(page);
    expect(credentialOf(list, registryId())).toBe('set');
    // A built-in huggingface shows `set` when the agent has HF_TOKEN; the initial record says whether it did.
    const exempt = new Set(state.initial.registries.filter((entry) => entry.credential !== 'none').map((entry) => entry.id));
    const others = list.registries.filter((entry) => entry.id !== registryId() && !exempt.has(entry.id));
    expect(others.map((entry) => `${entry.id}=${entry.credential}`).filter((line) => !line.endsWith('=none')), 'every other registry has no credential').toEqual([]);
    evidence('credential-set.json', { id: registryId(), credential: credentialOf(list, registryId()), others: list.registries.map((entry) => ({ id: entry.id, credential: entry.credential })) });
  });

  declare('credentials', 2, async ({ page }) => {
    test.setTimeout(20 * 60_000);
    await ensureExplorer(page);
    const before = await startedAtOf();
    const result = await state.ploinky(['restart', 'local-llm'], { timeoutMs: 10 * 60_000 });
    expect(result.status, `ploinky restart local-llm exited ${result.status}: ${result.stderr.slice(-400)}`).toBe(0);
    state.localLlm = nestedNameOf(await listNested({ boxName: state.box.name }), LOCAL_LLM_REF);
    const after = await startedAtOf();
    expect(Date.parse(after), `the restart did not run: StartedAt ${before} -> ${after}`).toBeGreaterThan(Date.parse(before));
    await localLlmAnswers(page);
    const list = await registryList(page);
    expect(list.credentialStorage.available).toBe(true);
    expect(credentialOf(list, registryId()), 'the credential is still readable after the restart').toBe('set');
    evidence('restart.json', { startedAtBefore: before, startedAtAfter: after, credentialStorage: list.credentialStorage, credential: credentialOf(list, registryId()) });
  });

  declare('credentials', 3, async () => {
    test.setTimeout(10 * 60_000);
    expect(typeof state.dummy, 'the dummy credential was set by the earlier test').toBe('string');
    // grep -c: exit 0 is some matches, 1 is none, 2 is a missing file or an error. Counts only reach the evidence.
    const counts = {};
    const countIn = async (file) => {
      const result = await exec(['grep', '-cF', '--', state.dummy, file]);
      if (result.status === 1) return 0;
      if (result.status === 0) return Number.parseInt(result.stdout.trim(), 10);
      throw new Error(`grep over ${file} exited ${result.status}: the file is missing or unreadable, so the scan proves nothing`);
    };
    for (const file of ['/data/state/controller.json', STATE_FILES.registries, STATE_FILES.credentials]) counts[file] = await countIn(file);
    const logs = await exec(['find', '/data/logs', '-type', 'f']);
    if (logs.status !== 0) throw new Error(`listing /data/logs exited ${logs.status}`);
    for (const file of logs.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) counts[file] = await countIn(file);
    const stdout = await runCommand('podman', [...nestedArgs(state.box.name), 'container', 'logs', state.localLlm], { timeoutMs: 60_000 });
    if (stdout.status !== 0) throw new Error(`reading the agent stdout exited ${stdout.status}`);
    counts['container stdout and stderr'] = `${stdout.stdout}\n${stdout.stderr}`.split(state.dummy).length - 1;
    // Positive control: the scan finds something that is there.
    const control = await exec(['grep', '-cF', '--', registryId(), STATE_FILES.registries]);
    evidence('leak-scan.json', { counts, positiveControl: { needle: 'the registry id', exit: control.status, count: control.status === 0 ? Number.parseInt(control.stdout.trim(), 10) : 0 } });
    expect(control.status, 'the scan can find the registry id it is looking for in registries.json').toBe(0);
    expect(Object.values(counts).filter((count) => count !== 0), `matches of the dummy credential by file: ${JSON.stringify(counts)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// negative controls

test.describe('negative controls', () => {
  test.describe.configure({ mode: 'serial' });
  const group = groups['negative controls'];
  const results = [];
  const loopbackId = () => `loopback-neg-${state.run}`;

  test.beforeAll(async ({ browser }) => {
    await withAdminPage(browser, smokeConfig.baseURL, async (page) => {
      await assertRegistryAbsent(page, loopbackId());
      await saveRegistry(page, group, { id: loopbackId(), kind: 'huggingface', url: 'https://localhost:9', label: 'Loopback (E2E negative control)' });
    });
  });
  test.afterAll(async ({ browser }) => { await restoreGroup(browser, group); });

  // A failed tool reaches callTool as text with value === null: only toolErrorCode reads its code.
  async function refused(page, args, expected) {
    await ensureExplorer(page);
    const reply = await callTool(page, { tool: 'local_llm_model_lookup', args });
    results.push({ args, ok: reply.ok, code: toolErrorCode(reply), expected, text: reply.text.slice(0, 200) });
    evidence('negative-controls.json', results);
    expect(reply.ok, `the lookup of ${JSON.stringify(args)} must fail`).toBe(false);
    expect(toolErrorCode(reply), `reply text: ${reply.text.slice(0, 300)}`).toBe(expected);
  }

  declare('negative controls', 0, async ({ page }) => {
    await refused(page, { registry: 'ghcr', repo: 'pauldotyu/modelkits/smollm2-360m-instruct', revision: 'latest' }, 'unsupported_artifact');
  });
  declare('negative controls', 1, async ({ page }) => {
    await refused(page, { registry: 'dockerhub', repo: 'library/ubuntu', revision: 'latest' }, 'unsupported_artifact');
  });
  declare('negative controls', 2, async ({ page }) => {
    await refused(page, { registry: 'modelscope', repo: GGUF_REPO, revision: 'no-such-ref-xyz' }, 'not_found');
  });
  declare('negative controls', 3, async ({ page }) => {
    await refused(page, { registry: loopbackId(), repo: 'owner/name', revision: 'main' }, 'address_refused');
  });
});

// ---------------------------------------------------------------------------
// GGUF

test.describe('GGUF', () => {
  test.describe.configure({ mode: 'serial' });
  const group = groups.GGUF;

  test.beforeAll(async ({ browser }) => {
    await withAdminPage(browser, smokeConfig.baseURL, async (page) => {
      await assertRegistryAbsent(page, `hf-self-${state.run}`);
      await saveRegistry(page, group, { id: `hf-self-${state.run}`, kind: 'huggingface', url: 'https://huggingface.co', label: 'Hugging Face again (E2E)' });
    });
    await dockerHubRateLimit('before the GGUF group');
  });
  test.afterAll(async ({ browser }) => { await restoreGroup(browser, group); });

  async function exercise(page, def) {
    test.setTimeout(MODEL_READY_MS + 20 * 60_000);
    const { lookup, pinned, model } = await lookupAndAdd(page, group, def);
    await foreignComputeApps(model);
    const dir = storeDirOf('gguf', pinned);
    let seed;
    if (def.key === 'hf-self') {
      const seedFile = `/data/models/gguf/${GGUF_REPO}/${pinned.commit || pinned.revision}/${GGUF_FILE}`;
      const there = await exists(seedFile);
      seed = { path: seedFile, present: there, sha256: there ? (await exec(['sha256sum', seedFile])).stdout.split(/\s+/)[0] : null };
    }
    const started = await callToolOk(page, 'local_llm_run', { requestId: requestId('reg-run'), modelId: model.id, runnerId: def.runnerId });
    expect(started.deployment).toMatchObject({ modelId: model.id, runnerId: def.runnerId });
    const waited = await waitUntilReady(page, `${model.id} to be ready`);
    expect(waited.failed, `${model.id} did not reach ready: ${JSON.stringify(waited.failed)}`).toBeUndefined();
    const { ready } = waited;
    expect(await exists(dir), `the store directory ${dir} exists while the model runs`).toBe(true);
    const answers = await recordPrompts(page, model);
    let separation = null;
    if (def.key === 'hf-self') {
      const file = `${dir}/${GGUF_FILE}`;
      const sum = (await exec(['sha256sum', file])).stdout.split(/\s+/)[0];
      expect(sum, 'the file stored under the self-registered registry is the pinned file, byte for byte').toBe(pinned.sha256);
      const seedAfter = seed.present ? (await exec(['sha256sum', seed.path])).stdout.split(/\s+/)[0] : null;
      expect(seedAfter, 'the seed location is untouched by the self-registered download').toBe(seed.sha256);
      separation = { file, sha256: sum, pinned: pinned.sha256, seed, seedShaAfter: seedAfter };
    }
    const finished = await finishModel(page, def, { pinned, model });
    evidence(`${def.slug}-run.json`, {
      pinned, deployment: { id: ready.deployment.id, artifact: ready.deployment.artifact, admission: ready.deployment.admission }, answers, finished, separation, lookupCommit: lookup.commit ?? null,
    });
  }

  const defs = [0, 1, 2, 3].map((index) => () => GGUF_DEFS()[index]);
  defs.forEach((definition, index) => {
    declare('GGUF', index, async ({ page }) => {
      await exercise(page, definition());
      if (index === defs.length - 1) await dockerHubRateLimit('after the GGUF group');
    });
  });
});

// ---------------------------------------------------------------------------
// snapshot

test.describe('snapshot', () => {
  test.describe.configure({ mode: 'serial' });
  const group = groups.snapshot;

  test.afterAll(async ({ browser }) => { await restoreGroup(browser, group); });

  declare('snapshot', 0, async ({ page }) => {
    test.setTimeout(INSTALL_MS + 15 * 60_000);
    await ensureExplorer(page);
    const value = await overview(page);
    expect(value.profile, 'the snapshot group needs the dedicated profile (vLLM on the RTX 3060), not another one').toBe('dedicated');
    const runner = (value.runners || []).find((entry) => entry.id === VLLM) || {};
    expect(runner.pinnedVersion, 'the overview names the installable vLLM version').toBeTruthy();
    expect(runner.enabled, 'vLLM is enabled on the dedicated profile without an operator switch').toBe(true);
    state.vllmVersion = runner.pinnedVersion;
    const { paramSchema, ...runnerView } = runner;
    evidence('vllm.json', { pinnedVersion: runner.pinnedVersion, alreadyInstalled: Boolean(runner.installed), installedVersion: runner.version ?? null, runner: runnerView });
    if (runner.installed) return;
    // A failure at or after the runner install is unrelated to the registries: a partial verdict, never a pass.
    try {
      const install = await callToolOk(page, 'local_llm_runner_install', { runnerId: VLLM });
      group.installedVllm = true;
      expect(install).toMatchObject({ accepted: true, install: { version: runner.pinnedVersion } });
      await waitFor(async () => {
        const current = await overview(page);
        const found = (current.runners || []).find((entry) => entry.id === VLLM) || {};
        if (found.install?.state?.error) throw new Error(`The vLLM install failed: ${JSON.stringify(found.install.state.error).slice(0, 300)}`);
        return found.installed ? current : null;
      }, { timeoutMs: INSTALL_MS, intervalMs: 10_000, label: 'vLLM to install' });
    } catch (error) {
      state.vllmUnavailable = true;
      notePartial({ modelId: 'vllm', phase: 'runner install', reason: String(error?.message || error).slice(0, 400) });
    }
  });

  async function exercise(page, def) {
    test.setTimeout(MODEL_READY_MS + 20 * 60_000);
    const { pinned, model } = await lookupAndAdd(page, group, def);
    const unrelated = [];
    let ready = null;
    if (state.vllmUnavailable) {
      unrelated.push({ modelId: model.id, phase: 'runner install', reason: 'vLLM is not installed, so the model cannot run' });
    } else {
      const params = { maxModelLen: 4096 };
      const preview = (await callToolOk(page, 'local_llm_overview', { preview: { modelId: model.id, runnerId: VLLM, params } })).preview;
      await foreignComputeApps(model);
      const started = await callTool(page, { tool: 'local_llm_run', args: { requestId: requestId('reg-vllm'), modelId: model.id, runnerId: VLLM, params } });
      if (!started.ok) {
        const code = toolErrorCode(started);
        if (!/^(runner|admission|budget|gpu)_/.test(code)) throw new Error(`Run of ${model.id} was refused before it started: ${started.text.slice(0, 300)}`);
        unrelated.push({ modelId: model.id, phase: 'run', reason: `${code}: ${started.text.slice(0, 300)}` });
      } else {
        const waited = await waitUntilReady(page, `${model.id} on vLLM to be ready`);
        if (waited.failed) {
          if (!['starting', 'loading'].includes(waited.failed.phase)) throw new Error(`${model.id} failed while ${waited.failed.phase}: ${waited.failed.reason}`);
          unrelated.push({ modelId: model.id, phase: waited.failed.phase, reason: waited.failed.reason });
        } else ready = waited.ready;
      }
      evidence(`${def.slug}-admission.json`, { params, admission: preview?.admission ?? null });
    }
    const answers = ready ? await recordPrompts(page, model) : [];
    const finished = await finishModel(page, def, { pinned, model, partial: unrelated.length > 0 });
    evidence(`${def.slug}-run.json`, { pinned, vllmVersion: state.vllmVersion, deployment: ready ? { id: ready.deployment.id, params: ready.deployment.params, admission: ready.deployment.admission } : null, answers, finished, unrelated });
    for (const entry of unrelated) notePartial(entry);
  }

  const defs = [0, 1].map((index) => () => SNAPSHOT_DEFS()[index]);
  defs.forEach((definition, index) => {
    declare('snapshot', index + 1, async ({ page }) => {
      await exercise(page, definition());
      if (index === defs.length - 1) await dockerHubRateLimit('after the snapshot group');
    });
  });
});

// ---------------------------------------------------------------------------
// final restore

test.describe('final restore', () => {
  test.describe.configure({ mode: 'serial' });

  declare('final restore', 0, async ({ page }) => {
    test.setTimeout(10 * 60_000);
    await ensureExplorer(page);
    const problems = [];
    const entries = [];
    const record = (label, ok, detail, action = null) => { entries.push({ label, ok, action, detail }); if (!ok) problems.push(`${label}: ${detail}`); };

    for (const group of Object.values(groups)) {
      const file = path.join(evidenceDir, `restore-${group.slug}.json`);
      if (!fs.existsSync(file)) { record(`restore-${group.slug}.json`, false, 'missing'); continue; }
      const results = JSON.parse(fs.readFileSync(file, 'utf8'));
      const bad = results.filter((result) => result.ok !== true);
      record(`restore-${group.slug}.json`, Array.isArray(results) && bad.length === 0, bad.length ? `${bad.length} failed: ${bad.map((result) => result.label).join(', ')}` : `${results.length} steps ok`);
    }

    const list = await registryList(page);
    for (const initial of state.initial.registries.filter((entry) => entry.builtIn && entry.id !== 'huggingface')) {
      const current = list.registries.find((entry) => entry.id === initial.id);
      if (current && current.enabled !== initial.enabled) {
        await callToolOk(page, 'local_llm_registry_save', { registry: { id: initial.id, enabled: initial.enabled } });
        record(`built-in ${initial.id} enabled`, true, `restored to ${initial.enabled}`);
      }
    }
    const initialIds = state.initial.registries.map((entry) => entry.id).sort();
    const currentIds = (await registryList(page)).registries.map((entry) => entry.id).sort();
    record('registry ids match the initial record', JSON.stringify(initialIds) === JSON.stringify(currentIds), `initial ${initialIds.join(',')}; current ${currentIds.join(',')}`);

    for (const [name, file] of Object.entries(STATE_FILES)) {
      const initiallyPresent = state.initial.files[name];
      const currentExit = (await exec(['test', '-e', file])).status;
      let step = stateFileRestoreStep({ initiallyPresent, currentExit });
      if (!initiallyPresent && step.action === 'remove') {
        // The run created the file: remove it by exact path (no -f), then it must be absent.
        const removal = await exec(['rm', '--', file]);
        const removedExit = (await exec(['test', '-e', file])).status;
        step = stateFileRestoreStep({ initiallyPresent, currentExit, removedExit });
        if (removal.status !== 0 && step.ok) step = { ...step, ok: false, detail: `rm exited ${removal.status}` };
      }
      record(`state file ${name}`, step.ok, step.detail, step.action);
    }
    evidence('restore-final.json', entries);
    expect(problems, 'the final restore found state the groups did not undo').toEqual([]);
  });
});
