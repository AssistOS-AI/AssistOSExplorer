// E2E-C core (release plan C2, C8): the administrator Hardware limits surface of a gate-on Box deployment.
//
// Six tests, one per concern, run in order against the same deployment:
//   1 admin-only tab, links-only Administration       4 usage and the read-only Workspace Monitor
//   2 panel facts and disclosures                     5 API probes P-BND-1..3, P-ORP-1, P-ERR-1
//   3 save -> pending, Apply, kernel readback         6 API probes P-CON-1, P-CON-2, P-IDEM-2
//
// Prerequisites fail the run; nothing here skips except the documented SMOKE_HARDWARE_LIMITS flag, and the gate
// requires `6 passed` with zero skipped. The stored override of test 3 stays in place on purpose: E2E-E needs
// stored limits for the U9 refusal and clears them afterwards with `ploinky limits clear --all`.
import path from 'node:path';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig, smokeArtifactPath } from '../lib/config.mjs';
import { explorerUrl, openExplorer } from '../lib/explorer.mjs';
import {
  agentByRef,
  cpuMaxMatches,
  createEvidenceWriter,
  createHardwareApi,
  diffRunningSets,
  findSingleInstanceAgent,
  HARDWARE_ENDPOINT,
  instanceByKey,
  onlyExpectedChanged,
  readLeaf,
  readRunningSet,
  requireHardwareEnvironment,
  resolveMemoryPercent,
  sameToken,
  tokenOf,
  waitFor,
} from '../lib/hardware-limits-evidence.mjs';

const TARGET = 'tasksAgent';
const GPU_TARGET_REF = 'local-llms/local-llm';
const LIMITS = Object.freeze({ cpus: 0.5, memoryPercent: 10 });
const APPLY_BOUND_MS = 5 * 60_000;
const PARALLEL_BOUND_MS = 60_000;

const evidence = createEvidenceWriter({ dir: path.dirname(smokeArtifactPath('hwl', '.keep')) });
const screenshot = (page, name) => page.screenshot({ path: smokeArtifactPath('hwl', 'screenshots', name), fullPage: false });
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let boxName = '';
const probeLog = {};

test.describe('Hardware limits administrator panel and API @hardware-limits', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!smokeConfig.flags.hardwareLimits, 'Set SMOKE_HARDWARE_LIMITS=1 to run the hardware-limits executors.');

  test.beforeAll(() => {
    ({ boxName } = requireHardwareEnvironment());
  });

  async function openPanel(page, account = smokeConfig.primaryUser) {
    await openExplorer(page, { account });
    await page.locator('#accountMenuButton').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    const dialog = page.locator('dialog.settings-modal-dialog');
    await expect(dialog).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
    return dialog;
  }

  async function openHardwareTab(page) {
    const dialog = await openPanel(page);
    const tab = dialog.getByRole('tab', { name: 'Hardware limits' });
    await expect(tab, 'an administrator must see the Hardware limits tab').toBeVisible({ timeout: smokeConfig.timeouts.navigation });
    await tab.click();
    const section = dialog.locator('[data-section="hardware"]');
    await expect(section.locator('article.hardware-policy').first()).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
    return { dialog, section };
  }

  const policyArticle = (page, section, ref) => section.locator('article.hardware-policy')
    .filter({ has: page.locator('h3').filter({ hasText: new RegExp(`^${escapeRe(ref)}$`) }) });
  const instanceRow = (page, article, key) => article.locator('table.hardware-instances tbody tr')
    .filter({ has: page.locator('code').filter({ hasText: new RegExp(`^${escapeRe(key)}$`) }) });

  // The leaf of the exact running instance, read by the Box user (no write).
  async function leafOf(key) {
    const running = await readRunningSet({ boxName });
    const entry = running.find((candidate) => candidate.name === key);
    if (!entry) throw new Error(`The instance ${key} is not in the nested running set.`);
    return { running, entry, leaf: await readLeaf({ boxName, containerId: entry.id }) };
  }

  async function applied(api, key) {
    return waitFor(async () => {
      const snapshot = await api.readOk();
      const found = instanceByKey(snapshot, key);
      return found && found.instance.availability === 'ready' && found.instance.limitsState === 'applied' ? snapshot : null;
    }, { timeoutMs: APPLY_BOUND_MS, intervalMs: 2000, label: `${key} to be ready with applied limits` });
  }

  async function expectNoMutation(api, before, ref) {
    const after = await api.readOk();
    expect(sameToken(tokenOf(after), tokenOf(before)), 'the policy token must be unchanged').toBe(true);
    expect(agentByRef(after, ref).configured, 'the stored override must be unchanged').toEqual(agentByRef(before, ref).configured);
  }

  test('Hardware limits is an administrator-only tab and Administration stays links-only', async ({ page, browser, request }) => {
    // Anonymous: no snapshot.
    const anonymous = await createHardwareApi({ request }).read();
    expect([401, 403], 'an anonymous caller must not read the hardware snapshot').toContain(anonymous.status);

    // Administrator: the tab exists; Administration is navigation only.
    const dialog = await openPanel(page);
    await expect(dialog.getByRole('tab', { name: 'Hardware limits' })).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
    await dialog.getByRole('tab', { name: 'Administration' }).click();
    const administration = dialog.locator('[data-section="users"]');
    await expect(administration.locator('a.settings-page-link:visible').first()).toBeVisible();
    for (const link of await administration.locator('a.settings-page-link').all()) {
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
    }
    expect(await administration.locator('input, select, textarea, button, [data-hardware-field], [data-hardware-action], hardware-limits-panel').count(),
      'Administration must contain links only, no hardware control').toBe(0);
    await screenshot(page, '90-administration-links-only.png');

    // A signed-in non-administrator: no tab, and the API refuses.
    const context = await browser.newContext({ baseURL: smokeConfig.baseURL, ignoreHTTPSErrors: true });
    const other = await context.newPage();
    try {
      await openExplorer(other, { account: smokeConfig.secondaryUser });
      const identity = await (await other.request.get('/auth/token', { headers: { accept: 'application/json', connection: 'close' } })).json();
      const roles = (identity?.user?.roles || []).map((role) => String(role).toLowerCase());
      expect(roles.includes('admin') || String(identity?.user?.username || '').toLowerCase() === 'admin',
        'SMOKE_SECONDARY_USERNAME must be a non-administrator account').toBe(false);
      const denied = other.waitForResponse((response) => new URL(response.url()).pathname === HARDWARE_ENDPOINT && response.request().method() === 'GET',
        { timeout: smokeConfig.timeouts.navigation });
      await other.locator('#accountMenuButton').click();
      await other.getByRole('menuitem', { name: 'Settings' }).click();
      const otherDialog = other.locator('dialog.settings-modal-dialog');
      await expect(otherDialog).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
      expect([401, 403], 'the panel read of a non-administrator must be refused').toContain((await denied).status());
      await expect(otherDialog.getByRole('tab', { name: 'Hardware limits' })).toHaveCount(0);
      const otherApi = createHardwareApi({ request: other.request });
      expect([401, 403]).toContain((await otherApi.read()).status);
      const attempted = await otherApi.post({ action: 'apply', expectedToken: { epoch: 'x', revision: 1 }, containers: [] });
      expect([401, 403], 'a non-administrator must not mutate hardware policy').toContain(attempted.status);
    } finally {
      await context.close();
    }
    evidence.write('90-admin-only.json', { anonymousStatus: anonymous.status, administrationControls: 0 });
  });

  test('the panel states the gate, envelope, GPU best-effort help and the accepted authority disclosure', async ({ page }) => {
    const api = createHardwareApi({ request: page.request });
    const { section } = await openHardwareTab(page);
    const snapshot = await api.readOk();
    expect(snapshot.gate.state).toBe('on');
    expect(snapshot.gate.prepared).toBe(true);
    expect(snapshot.gate.controllers).toEqual(expect.arrayContaining(['cpu', 'memory', 'pids']));
    expect(Number.isFinite(snapshot.envelope?.cpus) && snapshot.envelope.cpus > 0).toBe(true);
    expect(Number.isSafeInteger(snapshot.envelope?.memoryBytes) && snapshot.envelope.memoryBytes > 0).toBe(true);

    const facts = section.locator('.hardware-limits-facts').first();
    await expect(facts).toContainText('Gate on; prepared.');
    await expect(facts).toContainText(`Envelope ${snapshot.envelope.cpus} CPU cores /`);
    await expect(facts).toContainText(`Controllers: ${snapshot.gate.controllers.join(', ')}.`);
    await expect(section).toContainText('Saving changes desired policy. Apply recreates exact instances.');
    await expect(section.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Apply all pending', exact: true })).toBeVisible();
    await expect(section).toContainText(`GPU ${snapshot.gpu.mode} (${snapshot.gpu.assurance}).`);
    const gpuFields = section.locator('[data-hardware-field="smPercent"], [data-hardware-field="vramPercent"]');
    for (const field of await gpuFields.all()) {
      if (snapshot.gpu.eligible === true) await expect(field).toBeEnabled();
      else await expect(field).toBeDisabled();
    }

    // The GPU best-effort help (U6) and the accepted administrator-authority exposure (U13), exactly the server's sentences.
    const help = section.locator('details.hardware-limit-help');
    await help.locator('summary').click();
    await expect(help).toHaveAttribute('open', '');
    expect(snapshot.help.gpu.length).toBeGreaterThanOrEqual(6);
    for (const sentence of snapshot.help.gpu) await expect(help).toContainText(sentence);
    await expect(help).toContainText('best-effort, not a security boundary');
    await expect(help).toContainText('workspace master key');
    await expect(help).toContainText('forge administrator cookie/CSRF requests');
    await expect(help).toContainText('accepted for v1');
    expect(snapshot.help.authority).toMatch(/workspace master key[\s\S]*forge administrator cookie\/CSRF requests[\s\S]*accepted for v1/);
    await expect(help).toContainText('An optional no-wait child refusal does not block its parent.');
    await expect(help).toContainText('ploinky limits status');
    await expect(help).toContainText('ploinky limits clear');
    await screenshot(page, '90-panel-facts-and-disclosures.png');
    evidence.write('90-panel-facts.json', { gate: snapshot.gate, envelope: snapshot.envelope, gpu: { mode: snapshot.gpu.mode, assurance: snapshot.gpu.assurance, eligible: snapshot.gpu.eligible === true }, helpSentences: snapshot.help.gpu.length });
  });

  test('saving desired limits shows pending, and Apply recreates only the exact instance and reads back the kernel limits', async ({ page }) => {
    test.setTimeout(2 * APPLY_BOUND_MS);
    const api = createHardwareApi({ request: page.request });
    const before = await api.readOk();
    const { agent, instance } = findSingleInstanceAgent(before, TARGET);
    const runningBefore = await readRunningSet({ boxName });
    expect(runningBefore.some((entry) => entry.name === instance.key), 'the target is in the nested running set').toBe(true);

    const { section } = await openHardwareTab(page);
    const article = policyArticle(page, section, agent.ref);
    await expect(article).toBeVisible();
    await article.locator('[data-hardware-field="cpus"]').fill(String(LIMITS.cpus));
    await article.locator('[data-hardware-field="memoryPercent"]').fill(String(LIMITS.memoryPercent));
    await article.getByRole('button', { name: 'Save desired limits' }).click();

    const row = instanceRow(page, article, instance.key);
    await expect(row.locator('.hardware-instance-state')).toBeVisible();
    await expect(row, 'saving must show the instance as pending, not applied').toContainText(/pending/, { timeout: smokeConfig.timeouts.navigation });
    const saved = await api.readOk();
    expect(agentByRef(saved, agent.ref).configured).toMatchObject({ cpus: LIMITS.cpus, memoryPercent: LIMITS.memoryPercent });
    expect(tokenOf(saved).revision).toBeGreaterThan(tokenOf(before).revision);
    expect(instanceByKey(saved, instance.key).instance.limitsState).toBe('pending');
    // Saving recreated nothing.
    expect(diffRunningSets(runningBefore, await readRunningSet({ boxName })).changed).toEqual([]);
    await screenshot(page, '90-saved-pending.png');

    // Apply the exact instance.
    await row.getByRole('button', { name: 'Apply instance' }).click();
    await expect(section.getByText('Apply results')).toBeVisible({ timeout: APPLY_BOUND_MS });
    const finished = await applied(api, instance.key);
    const found = instanceByKey(finished, instance.key).instance;
    const expectedBytes = resolveMemoryPercent(LIMITS.memoryPercent, finished.envelope.memoryBytes);
    expect(found.limits.cpu).toMatchObject({ cores: LIMITS.cpus, assurance: 'kernel' });
    expect(found.limits.memory).toMatchObject({ bytes: expectedBytes, assurance: 'kernel' });

    // Only the exact instance was recreated, and the kernel agrees.
    const { running: runningAfter, leaf } = await leafOf(instance.key);
    const diff = diffRunningSets(runningBefore, runningAfter);
    expect(onlyExpectedChanged(diff, [instance.key]), `only ${instance.key} may change identity; changed: ${diff.changed.join(', ')}`).toBe(true);
    expect(cpuMaxMatches(leaf.cpuMax, LIMITS.cpus), `cpu.max ${leaf.cpuMax}`).toBe(true);
    expect(leaf.memoryMax).toBe(String(expectedBytes));
    expect(leaf.swapMax, 'the swap cap must be exactly 0').toBe('0');
    await screenshot(page, '90-applied.png');
    evidence.write('90-apply-readback.json', {
      agent: agent.ref,
      instance: instance.key,
      requested: LIMITS,
      applied: found.limits,
      leaf: { path: leaf.leaf, cpuMax: leaf.cpuMax, memoryMax: leaf.memoryMax, swapMax: leaf.swapMax, pidsMax: leaf.pidsMax },
      runningSetDiff: diff,
    });
  });

  test('usage and the Workspace Monitor show the applied limits read-only', async ({ page }) => {
    const api = createHardwareApi({ request: page.request });
    const snapshot = await applied(api, (findSingleInstanceAgent(await api.readOk(), TARGET)).instance.key);
    const { agent, instance } = findSingleInstanceAgent(snapshot, TARGET);
    expect(agentByRef(snapshot, agent.ref).configured, 'test 3 must have stored the override').toMatchObject(LIMITS);

    const { section } = await openHardwareTab(page);
    const row = instanceRow(page, policyArticle(page, section, agent.ref), instance.key);
    await expect(row).toContainText(/Applied CPU 0\.5 cores \(kernel\); RAM [0-9.]+ (?:MiB|GiB|TiB) \(kernel\)/);
    await expect(row).toContainText(/Desired 0\.5 CPU cores/);
    await expect(row, 'usage must carry the applied quota and the RAM cap').toContainText(/CPU (?:unknown|[0-9.]+% of one core) \/ 50% quota; RAM (?:unknown|[0-9.]+ (?:B|KiB|MiB|GiB)) \/ [0-9.]+ (?:MiB|GiB|TiB)/);
    await waitFor(async () => !/CPU unknown/.test(await row.innerText()), { timeoutMs: 60_000, intervalMs: 2000, label: 'a measured CPU usage in the panel' });
    await screenshot(page, '90-usage.png');

    // The Workspace Monitor shows the same limits and offers no hardware control.
    const monitor = await page.context().newPage();
    try {
      await monitor.goto(explorerUrl('workspace-monitor-dashboard'), { waitUntil: 'load' });
      await expect(monitor.getByText('Hardware policy is read-only here.')).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
      await monitor.getByRole('tab', { name: 'Resources' }).click();
      const resourceRow = monitor.locator('[data-role="resource-rows"] tr')
        .filter({ has: monitor.locator('button.resource-runtime-selector').filter({ hasText: new RegExp(`^${escapeRe(TARGET)}$`) }) });
      await expect(resourceRow).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
      await expect(resourceRow).toContainText('/ 50% quota (0.5 cores, kernel)');
      await expect(resourceRow).toContainText('kernel limit');
      expect(await monitor.locator('[data-hardware-field], [data-hardware-action], hardware-limits-panel').count(), 'the monitor must not host a hardware control').toBe(0);
      await screenshot(monitor, '90-workspace-monitor.png');
    } finally {
      await monitor.close();
    }
    evidence.write('90-usage.json', { agent: agent.ref, instance: instance.key, usage: instanceByKey(await api.readOk(), instance.key).instance.usage });
  });

  test('API probes: boundary values, orphans, malformed input and refused callers leave the policy unchanged', async ({ page }) => {
    const api = createHardwareApi({ request: page.request });
    const base = await api.readOk();
    const token = tokenOf(base);
    const { agent } = findSingleInstanceAgent(base, TARGET);
    const ref = agent.ref;
    const set = (limits, overrides = {}) => api.post({ action: 'set_agent_limits', expectedToken: token, agentRef: ref, limits, ...overrides });
    const probes = [];
    const record = (id, result) => { probes.push({ id, status: result.status, error: result.body?.error ?? null, committed: result.body?.committed === true }); return result; };

    // P-BND-1: cpus below the minimum, and one hundredth above the envelope.
    const low = record('P-BND-1 cpus 0.04', await set({ cpus: 0.04 }));
    expect(low.status).toBe(400);
    expect(low.body.error).toBe('invalid_limits');
    const over = record('P-BND-1 envelope+0.01', await set({ cpus: Number((base.envelope.cpus + 0.01).toFixed(2)) }));
    expect(over.status).toBe(422);
    expect(over.body.error).toBe('exceeds_envelope');
    await expectNoMutation(api, base, ref);

    // P-BND-2: RAM percentages and a GPU share below the 512 MiB minimum.
    for (const memoryPercent of [0, 101, 50.5]) {
      const result = record(`P-BND-2 memoryPercent ${memoryPercent}`, await set({ memoryPercent }));
      expect(result.status, `memoryPercent ${memoryPercent}`).toBe(400);
      expect(result.body.error).toBe('invalid_limits');
    }
    // The VRAM probe needs a GPU-eligible target: tasksAgent has no GPU grant, so its answer would be the
    // generic gpu_sharing_unavailable and would never reach the 512 MiB minimum. local-llm is the GPU agent of the graph.
    expect(base.gpu?.eligible, `MPS sharing must be eligible for the VRAM probe: ${String(base.gpu?.reason || 'no reason').slice(0, 200)}`).toBe(true);
    const gpuAgent = agentByRef(base, GPU_TARGET_REF);
    expect(gpuAgent, `${GPU_TARGET_REF} must be installed for the VRAM probe`).toBeTruthy();
    const vram = record('P-BND-2 vramPercent 8', await api.post({ action: 'set_agent_limits', expectedToken: token, agentRef: GPU_TARGET_REF, limits: { gpu: { smPercent: 50, vramPercent: 8 } } }));
    // 8 % of the 6144 MiB device is 491 MiB. The route's GPU qualification (409 gpu_sharing_unavailable) and the store
    // (422 exceeds_envelope) both word the refusal "below the 512 MiB minimum"; any other message (no current GPU
    // access, image not prepared, store busy) means the minimum was not reached and the probe fails.
    expect(['409 gpu_sharing_unavailable', '422 exceeds_envelope'], `vramPercent 8 answered ${vram.status} ${vram.body.error}: ${String(vram.body.message || '').slice(0, 200)}`)
      .toContain(`${vram.status} ${vram.body.error}`);
    expect(String(vram.body.message), 'the refusal must name the 512 MiB minimum').toMatch(/below the 512 MiB minimum/);
    expect(vram.body.ok).toBe(false);
    expect(vram.body.committed).not.toBe(true);
    await expectNoMutation(api, base, GPU_TARGET_REF);
    await expectNoMutation(api, base, ref);

    // P-BND-3: a body of 16,385 bytes (valid JSON padded with whitespace), an over-long and a non-ASCII reference.
    const small = JSON.stringify({ action: 'set_agent_limits', expectedToken: token, agentRef: ref, limits: { cpus: 0.5 } });
    const padded = record('P-BND-3 16385 bytes', await api.post(null, { rawBody: small + ' '.repeat(16385 - Buffer.byteLength(small)) }));
    expect(padded.status).toBe(400);
    const longRef = record('P-BND-3 129-character component', await set({ cpus: 0.5 }, { agentRef: `${'a'.repeat(129)}/agent` }));
    expect(longRef.status).toBe(400);
    const unicodeRef = record('P-BND-3 non-ASCII reference', await set({ cpus: 0.5 }, { agentRef: 'répo/agënt' }));
    expect(unicodeRef.status).toBe(400);
    await expectNoMutation(api, base, ref);

    // P-ORP-1: an unknown container key and an unknown agent.
    const container = record('P-ORP-1 unknown container', await api.post({ action: 'apply', expectedToken: token, containers: ['hwl-nosuch-container'] }));
    expect(container.status).toBe(404);
    expect(container.body.error).toBe('unknown_container');
    const unknownAgent = record('P-ORP-1 nosuch/agent', await set({ cpus: 0.5 }, { agentRef: 'nosuch/agent' }));
    expect(unknownAgent.status).toBe(404);
    expect(unknownAgent.body.error).toBe('unknown_agent');
    await expectNoMutation(api, base, ref);

    // P-ERR-1: malformed JSON, a Bearer header (GET and POST), a wrong Origin.
    const malformed = record('P-ERR-1 malformed JSON', await api.post(null, { rawBody: '{"action":' }));
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe('invalid_json');
    const bearerGet = record('P-ERR-1 Bearer GET', await api.read({ headers: { authorization: 'Bearer not-a-real-token' } }));
    expect(bearerGet.status).toBe(403);
    expect(bearerGet.body.error).toBe('agent_forbidden');
    const bearerPost = record('P-ERR-1 Bearer POST', await api.post({ action: 'set_agent_limits', expectedToken: token, agentRef: ref, limits: { cpus: 0.5 } }, { headers: { authorization: 'Bearer not-a-real-token' } }));
    expect(bearerPost.status).toBe(403);
    expect(bearerPost.body.error).toBe('agent_forbidden');
    const wrongOrigin = record('P-ERR-1 wrong Origin', await api.post({ action: 'set_agent_limits', expectedToken: token, agentRef: ref, limits: { cpus: 0.5 } }, { origin: 'https://evil.example' }));
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.body.ok).toBe(false);
    await expectNoMutation(api, base, ref);
    probeLog.boundary = { token, probes };
    evidence.write('probes.json', probeLog);
  });

  test('API probes: parallel setters, parallel Apply and a repeated Apply are serialized and idempotent', async ({ page }) => {
    test.setTimeout(2 * APPLY_BOUND_MS);
    const api = createHardwareApi({ request: page.request });
    const start = await api.readOk();
    const { agent, instance } = findSingleInstanceAgent(start, TARGET);
    expect(agentByRef(start, agent.ref).configured, 'test 3 must have stored the override').toMatchObject(LIMITS);
    const probes = [];

    // P-CON-1: two parallel setters with the same token: exactly one 200 and one 409 revision_conflict.
    const token = tokenOf(start);
    const setter = (cpus) => api.post({ action: 'set_agent_limits', expectedToken: token, agentRef: agent.ref, limits: { cpus, memoryPercent: LIMITS.memoryPercent } });
    const [first, second] = await Promise.all([setter(0.6), setter(0.7)]);
    const statuses = [first.status, second.status].sort();
    probes.push({ id: 'P-CON-1', statuses, errors: [first.body?.error ?? null, second.body?.error ?? null] });
    expect(statuses, 'exactly one setter wins').toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    const winner = first.status === 200 ? 0.6 : 0.7;
    expect(loser.body.error).toBe('revision_conflict');
    const afterSet = await api.readOk();
    expect(agentByRef(afterSet, agent.ref).configured).toMatchObject({ cpus: winner, memoryPercent: LIMITS.memoryPercent });
    expect(tokenOf(afterSet).revision, 'one committed revision').toBe(tokenOf(start).revision + 1);

    // P-CON-2: two parallel Apply calls of the same exact key: one applies, the other is refused, both within 60 s.
    const runningBefore = await readRunningSet({ boxName });
    const applyToken = tokenOf(afterSet);
    const timed = async () => {
      const startedAt = Date.now();
      const result = await api.post({ action: 'apply', expectedToken: applyToken, containers: [instance.key] });
      return { ...result, elapsedMs: Date.now() - startedAt };
    };
    const [one, two] = await Promise.all([timed(), timed()]);
    probes.push({ id: 'P-CON-2', statuses: [one.status, two.status].sort(), errors: [one.body?.error ?? null, two.body?.error ?? null], elapsedMs: [one.elapsedMs, two.elapsedMs] });
    expect([one.status, two.status].sort(), 'one Apply wins and the other is a 409').toEqual([200, 409]);
    expect(Math.max(one.elapsedMs, two.elapsedMs), 'both Apply calls must answer within 60 s').toBeLessThan(PARALLEL_BOUND_MS);
    const finished = await applied(api, instance.key);
    const { running: runningAfter, leaf } = await leafOf(instance.key);
    const diff = diffRunningSets(runningBefore, runningAfter);
    expect(onlyExpectedChanged(diff, [instance.key]), `one recreate of ${instance.key} only; changed: ${diff.changed.join(', ')}`).toBe(true);
    expect(cpuMaxMatches(leaf.cpuMax, winner), `cpu.max ${leaf.cpuMax} after the winning setter`).toBe(true);

    // P-IDEM-2: repeating Apply after it applied is unchanged (or a stale-token 409), and no identity changes.
    const again = await api.post({ action: 'apply', expectedToken: tokenOf(finished), containers: [instance.key] });
    probes.push({ id: 'P-IDEM-2', status: again.status, error: again.body?.error ?? null, results: (again.body?.results || []).map((result) => result.state || result.status || null) });
    if (again.status === 200) {
      expect(again.body.ok).not.toBe(false);
      expect((again.body.results || []).every((result) => (result.state || result.status) === 'unchanged'), 'a repeated Apply must report unchanged').toBe(true);
    } else {
      // The token is the current one, so the only acceptable refusal is a revision conflict.
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('revision_conflict');
    }
    const runningIdem = await readRunningSet({ boxName });
    expect(diffRunningSets(runningAfter, runningIdem).changed, 'a repeated Apply must not change any identity').toEqual([]);
    probeLog.concurrency = { probes, winner, runningSetDiff: diff };
    evidence.write('probes.json', probeLog);
  });
});
