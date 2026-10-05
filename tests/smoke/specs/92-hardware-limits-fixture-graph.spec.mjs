// E2E-C fixture graph (release plan C2, C8): an owned fixture repository installed into the E2E workspace carries
//   - `aliased`   one agent enabled twice, as its canonical instance and as the alias FIXTURE.aliased.alias;
//   - `refused`   a D4 combination (host network with nestedPodman) whose stored limit the Box refuses;
//   - `dependant` an agent with a blocking edge to `refused`, therefore blocked;
//   - `static`    a dedicated static agent with a blocking edge to `refused`, served at FIXTURE.static.path.
// The apparatus wrapper installs the fixture and arranges the refusal BEFORE this spec runs (plan C7/N-1: preparation
// of the owned fixture graph); the spec observes it and fails closed when any piece is missing. Router availability
// while a static agent is blocked is NOT asserted here: the Explorer is the static app of this workspace, so such a
// check would pass trivially. It belongs to the dedicated workspace C3-v (plan C8b, N-5).
//
// Four tests (the gate requires `4 passed`, zero skipped). The teardown (afterAll) disables the fixture agents and
// the fixture repository through the Ploinky CLI and proves the 16-runtime graph again before E2E-E.
import path from 'node:path';

import { test, expect } from '../lib/fixtures.mjs';
import { signIn } from '../lib/auth.mjs';
import { smokeConfig, smokeArtifactPath } from '../lib/config.mjs';
import { openExplorer } from '../lib/explorer.mjs';
import { resolvePloinkyExecutable } from '../lib/ploinky-executable.mjs';
import {
  EXPECTED_GRAPH_RUNTIMES,
  agentByRef,
  createEvidenceWriter,
  createHardwareApi,
  diffRunningSets,
  instanceByKey,
  onlyExpectedChanged,
  readRunningSet,
  removeFixture,
  requireHardwareEnvironment,
  tokenOf,
  waitFor,
} from '../lib/hardware-limits-evidence.mjs';

// The fixture contract. Every name is the wrapper's to provide; none is read from the environment.
const FIXTURE = Object.freeze({
  repo: 'hwlFixture',
  aliased: Object.freeze({ name: 'aliased', alias: 'second' }),
  refused: Object.freeze({ name: 'refused' }),
  dependant: Object.freeze({ name: 'dependant' }),
  static: Object.freeze({ name: 'static', path: '/hwl-static/' }),
});
const ref = (entry) => `${FIXTURE.repo}/${entry.name}`;
const LIMITS = Object.freeze({ cpus: 0.25, memoryPercent: 5 });
const APPLY_BOUND_MS = 5 * 60_000;

const evidence = createEvidenceWriter({ dir: path.dirname(smokeArtifactPath('hwl', '.keep')) });
const screenshot = (page, name) => page.screenshot({ path: smokeArtifactPath('hwl', 'screenshots', name), fullPage: false });
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let boxName = '';

test.describe('Hardware limits fixture graph @hardware-limits', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!smokeConfig.flags.hardwareLimits, 'Set SMOKE_HARDWARE_LIMITS=1 to run the hardware-limits executors.');

  test.beforeAll(() => {
    ({ boxName } = requireHardwareEnvironment());
    if (!smokeConfig.workspaceRoot) throw new Error('SMOKE_WORKSPACE_ROOT must name the E2E workspace (the fixture teardown runs the Ploinky CLI there).');
    resolvePloinkyExecutable();
  });

  // The fixture graph exactly as the Box reports it; a missing piece is an error that names it.
  function fixtureGraph(snapshot) {
    const missing = [];
    const read = (entry) => {
      const agent = agentByRef(snapshot, ref(entry));
      if (!agent) missing.push(`${ref(entry)} is not installed`);
      return agent;
    };
    const aliased = read(FIXTURE.aliased);
    const refused = read(FIXTURE.refused);
    const dependant = read(FIXTURE.dependant);
    const staticAgent = read(FIXTURE.static);
    const canonical = aliased?.containers?.find((instance) => instance.alias == null);
    const alias = aliased?.containers?.find((instance) => instance.alias === FIXTURE.aliased.alias);
    if (aliased && !canonical) missing.push(`${ref(FIXTURE.aliased)} has no canonical instance`);
    if (aliased && !alias) missing.push(`${ref(FIXTURE.aliased)} has no instance with alias ${FIXTURE.aliased.alias}`);
    const only = (agent, label) => {
      if (agent && (agent.containers || []).length !== 1) missing.push(`${label} must have exactly one instance`);
      return agent?.containers?.[0];
    };
    const refusedInstance = only(refused, ref(FIXTURE.refused));
    const dependantInstance = only(dependant, ref(FIXTURE.dependant));
    const staticInstance = only(staticAgent, ref(FIXTURE.static));
    if (missing.length) throw new Error(`The owned fixture graph is not installed as the executor expects: ${missing.join('; ')}. The apparatus wrapper must install it before spec 92.`);
    return { aliased, canonical, alias, refusedInstance, dependantInstance, staticInstance };
  }

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

  const article = (page, section, agentRef) => section.locator('article.hardware-policy')
    .filter({ has: page.locator('h3').filter({ hasText: new RegExp(`^${escapeRe(agentRef)}$`) }) });
  const row = (page, scope, key) => scope.locator('table.hardware-instances tbody tr')
    .filter({ has: page.locator('code').filter({ hasText: new RegExp(`^${escapeRe(key)}$`) }) });

  async function readyWith(api, key, state) {
    return waitFor(async () => {
      const snapshot = await api.readOk();
      const found = instanceByKey(snapshot, key);
      return found && found.instance.availability === 'ready' && found.instance.limitsState === state ? snapshot : null;
    }, { timeoutMs: APPLY_BOUND_MS, intervalMs: 2000, label: `${key} to be ready with ${state} limits` });
  }

  test('alias rows show their exact keys, and an exact-key Apply recreates only that alias', async ({ page }) => {
    test.setTimeout(2 * APPLY_BOUND_MS);
    const api = createHardwareApi({ request: page.request });
    const before = await api.readOk();
    const graph = fixtureGraph(before);
    expect(graph.canonical.key).not.toBe(graph.alias.key);
    for (const instance of [graph.canonical, graph.alias]) expect(instance.availability, `${instance.key} must start ready`).toBe('ready');

    const section = await openHardwareTab(page);
    const policy = article(page, section, ref(FIXTURE.aliased));
    const canonicalRow = row(page, policy, graph.canonical.key);
    const aliasRow = row(page, policy, graph.alias.key);
    await expect(canonicalRow).toContainText('Canonical instance');
    await expect(aliasRow).toContainText(`Alias: ${FIXTURE.aliased.alias}`);
    await expect(canonicalRow.locator('code')).toHaveText(graph.canonical.key);
    await expect(aliasRow.locator('code')).toHaveText(graph.alias.key);

    // One stored policy per agent: both instances become pending, only the alias is applied.
    await policy.locator('[data-hardware-field="cpus"]').fill(String(LIMITS.cpus));
    await policy.locator('[data-hardware-field="memoryPercent"]').fill(String(LIMITS.memoryPercent));
    await policy.getByRole('button', { name: 'Save desired limits' }).click();
    await expect(canonicalRow).toContainText(/pending/, { timeout: smokeConfig.timeouts.navigation });
    await expect(aliasRow).toContainText(/pending/);
    const runningBefore = await readRunningSet({ boxName });
    await screenshot(page, '92-alias-rows-pending.png');

    await aliasRow.getByRole('button', { name: 'Apply instance' }).click();
    await expect(section.getByText('Apply results')).toBeVisible({ timeout: APPLY_BOUND_MS });
    const after = await readyWith(api, graph.alias.key, 'applied');
    const diff = diffRunningSets(runningBefore, await readRunningSet({ boxName }));
    expect(onlyExpectedChanged(diff, [graph.alias.key]), `only the alias may change identity; changed: ${diff.changed.join(', ')}`).toBe(true);
    expect(instanceByKey(after, graph.canonical.key).instance.limitsState, 'the canonical instance stays pending').toBe('pending');
    await screenshot(page, '92-alias-applied.png');
    evidence.write('92-alias-apply.json', { canonical: graph.canonical.key, alias: graph.alias.key, requested: LIMITS, runningSetDiff: diff, token: tokenOf(after) });
  });

  test('refused and blocked instances are separate causal rows with their own fixes', async ({ page }) => {
    const api = createHardwareApi({ request: page.request });
    const snapshot = await api.readOk();
    const graph = fixtureGraph(snapshot);
    const refusedRef = ref(FIXTURE.refused);
    const { refusedInstance, dependantInstance, staticInstance } = graph;

    expect(refusedInstance.availability).toBe('refused');
    expect(refusedInstance.problem?.reason, 'a refusal carries its reason').toEqual(expect.any(String));
    expect(refusedInstance.problem?.fix, 'a refusal carries its fix').toEqual(expect.any(String));
    for (const blocked of [dependantInstance, staticInstance]) {
      expect(blocked.availability, `${blocked.key} must be blocked, not refused`).toBe('blocked');
      expect(blocked.problem?.blockedBy?.ref || blocked.problem?.blockedBy?.key).toBeTruthy();
      expect(blocked.problem?.rootCause?.ref).toBe(refusedRef);
      expect(blocked.problem?.rootCause?.fix, 'a blocked row carries the root refusal fix').toEqual(expect.any(String));
    }
    expect(new Set([refusedInstance.key, dependantInstance.key, staticInstance.key]).size, 'three separate rows').toBe(3);

    const section = await openHardwareTab(page);
    const refusedRow = row(page, article(page, section, refusedRef), refusedInstance.key);
    await expect(refusedRow.locator('.hardware-instance-state')).toHaveText('refused');
    await expect(refusedRow.locator('.hardware-instance-problem')).toContainText('Refused.');
    await expect(refusedRow.locator('.hardware-instance-problem')).toContainText(refusedInstance.problem.reason);
    await expect(refusedRow.locator('.hardware-instance-problem')).toContainText(refusedInstance.problem.fix);
    await expect(refusedRow.locator('.hardware-instance-problem')).not.toContainText('Blocked by');
    // The limit state never overrides availability: the state cell reads `refused / unavailable`.
    await expect(refusedRow).toContainText(/refused \/ unavailable/);

    for (const [entry, blocked] of [[FIXTURE.dependant, dependantInstance], [FIXTURE.static, staticInstance]]) {
      const blockedRow = row(page, article(page, section, ref(entry)), blocked.key);
      const problem = blockedRow.locator('.hardware-instance-problem');
      await expect(blockedRow.locator('.hardware-instance-state')).toHaveText('blocked');
      await expect(problem).toContainText(`Blocked by ${blocked.problem.blockedBy.ref || blocked.problem.blockedBy.key}.`);
      await expect(problem).toContainText(`Root refusal ${blocked.problem.rootCause.ref}.`);
      await expect(problem).toContainText(blocked.problem.rootCause.fix);
      await expect(problem).not.toContainText('Refused.');
      await expect(blockedRow).toContainText(/blocked \/ unavailable/);
    }
    await screenshot(page, '92-refused-and-blocked-rows.png');
    evidence.write('92-causal-rows.json', {
      refused: { key: refusedInstance.key, availability: refusedInstance.availability, problem: refusedInstance.problem },
      blocked: [dependantInstance, staticInstance].map((instance) => ({ key: instance.key, availability: instance.availability, blockedBy: instance.problem.blockedBy, rootCause: instance.problem.rootCause })),
    });
  });

  test('only the expected identities change on each Apply', async ({ page }) => {
    test.setTimeout(2 * APPLY_BOUND_MS);
    const api = createHardwareApi({ request: page.request });
    const start = await api.readOk();
    const graph = fixtureGraph(start);
    const outcomes = [];

    // (a) The canonical instance, exact key.
    const runningA = await readRunningSet({ boxName });
    const applied = await api.post({ action: 'apply', expectedToken: tokenOf(start), containers: [graph.canonical.key] });
    expect(applied.status, `Apply of the canonical instance answered ${applied.status} ${applied.body?.error ?? ''}`).toBe(200);
    expect(applied.body.ok).not.toBe(false);
    await readyWith(api, graph.canonical.key, 'applied');
    const diffA = diffRunningSets(runningA, await readRunningSet({ boxName }));
    outcomes.push({ target: graph.canonical.key, diff: diffA });
    expect(onlyExpectedChanged(diffA, [graph.canonical.key]), `canonical Apply changed: ${diffA.changed.join(', ')}`).toBe(true);

    // (b) The refused instance: the refusal is reported, nothing is recreated, the dependants stay blocked.
    const midpoint = await api.readOk();
    const runningB = await readRunningSet({ boxName });
    const refusal = await api.post({ action: 'apply', expectedToken: tokenOf(midpoint), containers: [graph.refusedInstance.key] });
    // The server expands a refused root to the blocked dependants that recover with it (reconcile.mjs), so the answer is a
    // 207 whose results name the root as refused and exactly those dependants as blocked.
    expect(refusal.status, `Apply of the refused instance answered ${refusal.status} ${refusal.body?.error ?? ''}`).toBe(207);
    expect(refusal.body.ok).toBe(false);
    const resultOf = (key) => (refusal.body.results || []).find((result) => result.key === key);
    const refusedResult = resultOf(graph.refusedInstance.key);
    expect(refusedResult?.state, 'the refused root must be reported as refused').toBe('refused');
    expect(refusedResult.problem?.state).toBe('refused');
    expect(refusedResult.problem?.code, 'the refusal carries its typed code').toEqual(expect.any(String));
    expect(refusedResult.problem.code.length).toBeGreaterThan(0);
    expect([...(refusal.body.expandedContainers || [])].sort(), 'exactly the blocked dependants are coordinated with the root')
      .toEqual([graph.dependantInstance.key, graph.staticInstance.key].sort());
    for (const dependant of [graph.dependantInstance, graph.staticInstance]) expect(resultOf(dependant.key)?.state, `${dependant.key} must be reported as blocked`).toBe('blocked');
    const afterRefusal = await api.readOk();
    expect(instanceByKey(afterRefusal, graph.refusedInstance.key).instance.availability).toBe('refused');
    expect(instanceByKey(afterRefusal, graph.dependantInstance.key).instance.availability).toBe('blocked');
    expect(instanceByKey(afterRefusal, graph.staticInstance.key).instance.availability).toBe('blocked');
    const diffB = diffRunningSets(runningB, await readRunningSet({ boxName }));
    outcomes.push({ target: graph.refusedInstance.key, status: refusal.status, diff: diffB });
    expect(diffB.changed, 'a refused Apply must not recreate any identity').toEqual([]);

    // (c) Apply all pending, through the panel: only instances that were pending may be recreated.
    const beforeAll = await api.readOk();
    const pendingBefore = (beforeAll.agents || []).flatMap((agent) => agent.containers || [])
      .filter((instance) => instance.limitsState === 'pending' && instance.availability === 'ready').map((instance) => instance.key);
    const runningC = await readRunningSet({ boxName });
    const section = await openHardwareTab(page);
    await section.getByRole('button', { name: 'Apply all pending', exact: true }).click();
    await expect(section.getByText('Apply results')).toBeVisible({ timeout: APPLY_BOUND_MS });
    const diffC = diffRunningSets(runningC, await readRunningSet({ boxName }));
    outcomes.push({ target: 'apply-all', pendingBefore, diff: diffC });
    expect(diffC.changed.every((name) => pendingBefore.includes(name)),
      `Apply all pending may recreate only instances that were pending (${pendingBefore.join(', ') || 'none'}); changed: ${diffC.changed.join(', ') || 'none'}`).toBe(true);
    const afterAll = await api.readOk();
    expect(instanceByKey(afterAll, graph.refusedInstance.key).instance.availability, 'Apply all pending must not make the refused instance ready').toBe('refused');
    await screenshot(page, '92-apply-all-pending.png');
    evidence.write('92-apply-identities.json', { outcomes });
  });

  test('the blocked static fixture answers terminal-unavailable, not an endless startup or reload page', async ({ page, browser }) => {
    const api = createHardwareApi({ request: page.request });
    const graph = fixtureGraph(await api.readOk());
    expect(graph.staticInstance.availability).toBe('blocked');
    const reason = graph.staticInstance.problem.rootCause.reason;

    // The JSON form: a terminal 503, never a startup or retry answer.
    const json = await page.request.get(FIXTURE.static.path, { headers: { accept: 'application/json', connection: 'close' }, maxRetries: 0 });
    const body = await json.json().catch(() => null);
    expect(json.status()).toBe(503);
    expect(body).toMatchObject({ error: 'AGENT_HARDWARE_UNAVAILABLE', state: 'blocked', code: 'hardware_blocked' });
    expect(body.reason).toEqual(expect.any(String));
    expect(body.fix).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toMatch(/"state":"(?:starting|retry)"/);

    // The browser form, in its own signed-in context: a terminal page (or the same terminal JSON), no spinner, no
    // retry, and no further traffic. (A 503 navigation is expected here, so this page carries no failure diagnostics.)
    const context = await browser.newContext({ baseURL: smokeConfig.baseURL, ignoreHTTPSErrors: true });
    let settled;
    let afterWait;
    try {
      const other = await context.newPage();
      await openExplorer(other);
      const requests = [];
      const navigations = [];
      other.on('request', (request) => { if (new URL(request.url()).pathname === FIXTURE.static.path) requests.push(request.url()); });
      other.on('framenavigated', (frame) => { if (frame === other.mainFrame()) navigations.push(frame.url()); });
      await other.goto(FIXTURE.static.path, { waitUntil: 'load' });
      const startupRoot = other.locator('#agent-startup-root');
      if (await startupRoot.count()) {
        await expect(startupRoot).toHaveAttribute('data-ploinky-agent-startup-page', 'unavailable');
        await expect(other.locator('#agent-startup-spinner')).toBeHidden();
        await expect(other.locator('#agent-startup-retry')).toBeHidden();
        await expect(other.locator('#agent-startup-message')).toContainText(reason.slice(0, 60));
      } else {
        await expect(other.locator('body')).toContainText('AGENT_HARDWARE_UNAVAILABLE');
      }
      await screenshot(other, '92-static-terminal-unavailable.png');
      settled = { requests: requests.length, navigations: navigations.length };
      await other.waitForTimeout(8000);
      afterWait = { requests: requests.length, navigations: navigations.length };
      expect(afterWait, 'a terminal page must not poll or reload').toEqual(settled);
    } finally {
      await context.close();
    }
    evidence.write('92-static-terminal.json', { status: json.status(), code: body.code, state: body.state, settled, afterWait });
  });

  // Teardown: remove the fixture through the Ploinky CLI and prove the 16-runtime Explorer graph again before E2E-E.
  test.afterAll(async ({ browser }) => {
    test.setTimeout(3 * APPLY_BOUND_MS);
    const context = await browser.newContext({ baseURL: smokeConfig.baseURL, ignoreHTTPSErrors: true });
    try {
      const page = await context.newPage();
      await signIn(page, smokeConfig.primaryUser, '/');
      const api = createHardwareApi({ request: page.request });
      // Every instance is disabled by its exact registry key (also the alias instance) and every command is awaited.
      // `ploinky disable agent` exits 0 for a target that is not enabled or ambiguous, so the exit status is not proof:
      // the snapshot below is the authority.
      const removal = await removeFixture({
        bin: resolvePloinkyExecutable(),
        cwd: smokeConfig.workspaceRoot,
        repo: FIXTURE.repo,
        order: [ref(FIXTURE.static), ref(FIXTURE.dependant), ref(FIXTURE.refused), ref(FIXTURE.aliased)],
        readSnapshot: () => api.readOk(),
      });

      const proven = await waitFor(async () => {
        const snapshot = await api.readOk();
        if ((snapshot.agents || []).some((agent) => agent.ref.startsWith(`${FIXTURE.repo}/`) && (agent.containers || []).length)) return null;
        const instances = (snapshot.agents || []).flatMap((agent) => agent.containers || []);
        const ready = instances.filter((instance) => instance.availability === 'ready');
        if (instances.length !== EXPECTED_GRAPH_RUNTIMES || ready.length !== EXPECTED_GRAPH_RUNTIMES) return null;
        const running = new Set((await readRunningSet({ boxName })).map((entry) => entry.name));
        return ready.every((instance) => running.has(instance.key)) ? { instances: instances.length, ready: ready.length } : null;
      }, { timeoutMs: 3 * APPLY_BOUND_MS, intervalMs: 5000, label: `the ${EXPECTED_GRAPH_RUNTIMES}-runtime graph without the fixture` });
      evidence.write('92-teardown.json', { commands: removal.commands, graph: proven });
    } finally {
      await context.close();
    }
  });
});
