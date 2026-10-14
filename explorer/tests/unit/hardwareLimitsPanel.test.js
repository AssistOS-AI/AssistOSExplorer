import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createHardwareLimitsApi, hardwareAccessDenied, HardwareLimitsError } from '../../services/infrastructure/hardwareLimitsApi.js';
import { HardwareLimitsPanel, renderHardwareLimits } from '../../web-components/components/hardware-limits-panel/hardware-limits-panel.js';
import { createDraft, reconcileDrafts, draftLimits, describeProblem, GPU_HELP, AUTHORITY_HELP } from '../../web-components/components/hardware-limits-panel/hardware-limits-model.js';
import { hardwareController } from '../../web-components/modals/settings-modal/settings-hardware-controller.js';
import { SettingsModal } from '../../web-components/modals/settings-modal/settings-modal.js';
import { validateAgentEntry, validateAgentLimits } from '../../../../ploinky/cli/sandbox/hardwareLimits/store.mjs';

const token = (revision = 1) => ({ epoch: '1'.repeat(32), revision });
const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
const ref = 'repo/model';

function snapshot(revision = 1) {
    return {
        ok: true, token: token(revision), gate: { state: 'on', prepared: true, controllers: ['cpu', 'memory'] },
        envelope: { cpus: 8, memoryBytes: 8 * 1024 ** 3 }, gpu: { eligible: false, mode: 'unavailable', assurance: 'none' },
        agents: [{ ref, configured: { cpus: 1.5 }, declared: { memory: '1g' }, effective: { cpus: 1.5, memoryBytes: 1024 ** 3 }, containers: [
            { key: 'repo-model', alias: null, instanceId: 'one', availability: 'ready', limitsState: 'pending', limits: { cpu: { cores: 1.5, assurance: 'kernel' }, memory: { bytes: 1024 ** 3, assurance: 'kernel' } }, usage: { cpuPercent: 25, memoryBytes: 1024 ** 2 } },
            { key: 'repo-model-first', alias: 'first', availability: 'ready', limitsState: 'applied' },
            { key: 'repo-model-router', alias: 'router', availability: 'refused', limitsState: 'unavailable', problem: { reason: 'Memory controller absent.', fix: 'Run host repair.' } },
        ] }],
    };
}

function panel(api, value = snapshot()) {
    const element = { dispatchEvent() {}, querySelector() { return null; } };
    const presenter = new HardwareLimitsPanel(element, () => {}, { api });
    presenter.acceptSnapshot(value);
    return presenter;
}

test('X.exact-payload', async () => {
    const posts = [];
    const api = createHardwareLimitsApi({ expectedOrigin: 'http://box.test', fetchImplementation: async (url, options = {}) => {
        if (url === '/auth/token') return response({ ok: true, adminControl: { origin: 'http://box.test', csrfToken: 'fresh-proof' } });
        if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return response({ ok: true }); }
        return response(snapshot());
    } });
    await api.set(token(), ref, { cpus: 0.5, memoryPercent: 50 });
    await api.clear(token(), ref);
    await api.apply(token(), ['repo-model', 'repo-model-first', 'repo-model-router']);
    assert.deepEqual(posts, [
        { action: 'set_agent_limits', expectedToken: token(), agentRef: ref, limits: { cpus: 0.5, memoryPercent: 50 } },
        { action: 'clear_agent_limits', expectedToken: token(), agentRef: ref },
        { action: 'apply', expectedToken: token(), containers: ['repo-model', 'repo-model-first', 'repo-model-router'] },
    ]);
    const presenter = panel(api);
    await presenter.action({ hardwareAction: 'apply', agentIndex: '0', instanceIndex: '2' });
    assert.deepEqual(posts.at(-1).containers, ['repo-model-router']);
    await presenter.action({ hardwareAction: 'apply-all' });
    assert.deepEqual(posts.at(-1).containers, []);
});

test('X.fresh-proof', async () => {
    for (const mode of ['adminControl', 'browserMutation']) {
        let proofs = 0;
        const headers = [];
        const api = createHardwareLimitsApi({ expectedOrigin: 'https://box.test', fetchImplementation: async (url, options) => {
            if (url === '/auth/token') return response({ ok: true, [mode]: { origin: 'https://box.test', csrfToken: `proof-${++proofs}`, hostRouteKey: 'explorer', generation: 'g1' } });
            headers.push(options.headers);
            return headers.length === 1 ? response({ ok: false, error: mode === 'adminControl' ? 'csrf_invalid' : 'browser_csrf_invalid' }, 403) : response({ ok: true });
        } });
        await api.clear(token(), ref);
        const header = mode === 'adminControl' ? 'x-ploinky-csrf-token' : 'x-ploinky-browser-csrf-token';
        assert.deepEqual(headers.map((value) => value[header]), ['proof-1', 'proof-2']);
        assert.equal(proofs, 2);
    }
});

test('X.conflict-keeps-edits', async () => {
    let authoritative = snapshot(2);
    const posts = [];
    const api = createHardwareLimitsApi({ expectedOrigin: 'https://box.test', fetchImplementation: async (url, options = {}) => {
        if (url === '/auth/token') return response({ ok: true, adminControl: { origin: 'https://box.test', csrfToken: 'p' } });
        if (options.method === 'POST') { posts.push(JSON.parse(options.body)); authoritative = snapshot(3); return response({ ok: true, token: token(3) }); }
        return response(authoritative);
    } });
    const presenter = panel(api);
    presenter.edit({ dataset: { hardwareField: 'cpus', agentIndex: '0' }, value: '3.25' });
    await presenter.action({ hardwareAction: 'save', agentIndex: '0' });
    assert.equal(posts.length, 0);
    assert.equal(presenter.drafts.get(ref).cpus, '3.25');
    assert.equal(presenter.drafts.get(ref).conflict, true);
    assert.deepEqual(presenter.snapshot.token, token(2));
    assert.match(renderHardwareLimits(presenter.snapshot, presenter.drafts), /unsaved values remain/);
    await presenter.action({ hardwareAction: 'save', agentIndex: '0' });
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].expectedToken, token(2));
    assert.equal(posts[0].limits.cpus, 3.25);
});

test('X.pending-applied', () => {
    const value = snapshot();
    value.agents[0].containers[2].limitsState = 'applied';
    const html = renderHardwareLimits(value, reconcileDrafts(value.agents, value.token));
    assert.match(html, /ready<\/span> \/ pending/);
    assert.match(html, /refused<\/span> \/ applied/);
    assert.match(html, /150% quota/);
    assert.match(html, /1.0 GiB \(kernel\)/);
    assert.match(html, /Stored .*declared .*effective /);
});

test('X.refused-blocked-cause', () => {
    const refused = { availability: 'refused', problem: { reason: 'Quota exceeds envelope.', fix: 'Lower quota.' } };
    const blocked = { availability: 'blocked', problem: { blockedBy: { ref: 'repo/dependency' }, rootCause: { ref: 'repo/root', reason: 'Memory controller absent.', fix: 'Repair controller.' } } };
    assert.equal(describeProblem(refused), 'Refused. Quota exceeds envelope. Lower quota.');
    assert.equal(describeProblem(blocked), 'Blocked by repo/dependency. Root refusal repo/root. Memory controller absent. Repair controller.');
});

test('X.optional-child-parent-ready', () => {
    const value = snapshot();
    value.agents.push({ ref: 'repo/explorer', configured: {}, declared: {}, effective: {}, containers: [{ key: 'explorer', availability: 'ready', limitsState: 'applied' }] });
    const html = renderHardwareLimits(value, reconcileDrafts(value.agents, value.token));
    assert.match(html, /Canonical instance<code>explorer<\/code><\/td><td><span class="hardware-instance-state">ready/);
    assert.match(html, /Alias: router/);
    assert.match(html, /optional no-wait child refusal does not block its parent/);
});

test('X.admin-only', async (t) => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    for (const [status, error, allowed] of [[401, 'not_authenticated', false], [403, 'admin_required', false], [409, 'not_in_box', false], [503, 'store_unreadable', true], [422, 'hardware_refusal', true]]) {
        globalThis.fetch = async () => response({ ok: false, error }, status);
        const presenter = { state: { activeTab: 'agents' }, updateTabUI() {} };
        await hardwareController.refreshHardwareAccess.call(presenter);
        assert.equal(presenter.state.hardwareAccess, allowed);
        assert.equal(SettingsModal.prototype.getAllowedTabs.call(presenter).includes('hardware'), allowed);
    }
    assert.equal(hardwareAccessDenied(new HardwareLimitsError({ error: 'store_unreadable' }, 503)), false);
});

test('X.link-only-administration', async () => {
    const html = await fs.readFile(new URL('../../web-components/modals/settings-modal/settings-modal.html', import.meta.url), 'utf8');
    const admin = html.match(/<section[^>]*data-section="users"[^>]*>([\s\S]*?)<\/section>/)[1];
    assert.doesNotMatch(admin, /<(?:input|form|hardware-limits-panel)\b/);
    assert.match(html, /data-hardware-tab hidden[^>]*>Hardware limits/);
    assert.match(html, /data-section="hardware"/);
    assert.equal([...admin.matchAll(/<a\b/g)].length, 2);
});

test('X.gpu-best-effort-help', () => {
    const value = snapshot();
    let html = renderHardwareLimits(value, reconcileDrafts(value.agents, value.token));
    assert.match(html, /data-hardware-field="smPercent"[^>]* disabled/);
    for (const sentence of GPU_HELP) assert.ok(html.includes(sentence.replace(/'/g, '&#39;')));
    value.gpu.eligible = true;
    html = renderHardwareLimits(value, reconcileDrafts(value.agents, value.token));
    assert.doesNotMatch(html, /data-hardware-field="smPercent"[^>]* disabled/);
    const requested = draftLimits({ cpus: '', memoryPercent: '', smPercent: '50', vramPercent: '50' });
    assert.deepEqual(requested, { gpu: { smPercent: 50, vramPercent: 50 } });
    assert.deepEqual(validateAgentEntry(requested), requested);
    assert.throws(() => draftLimits({ smPercent: '25' }), /both/);
    assert.throws(() => draftLimits({ cpus: '0' }), /cpus/);
    assert.throws(() => draftLimits({ memoryPercent: 'NaN' }), /memoryPercent/);
    assert.throws(() => draftLimits({ memoryPercent: '12.5' }), /whole number/);
    assert.throws(() => draftLimits({ cpus: '0.01' }), /cpus/);
    assert.throws(() => draftLimits({ cpus: '1.234' }), /two decimal/);
});

const UNIFIED_SENTENCE = "On unified-memory NVIDIA GPUs (GB10 / DGX Spark) a RAM limit does not cap the GPU device memory (cudaMalloc) an agent allocates, such as llama.cpp's model buffers; only the agent's own admission check keeps that memory within the budget, and an overrun takes memory from the whole host, which has no separate GPU memory. Managed, pinned-host and ATS allocations are charged to the RAM limit (measured on driver 580.178.04).";
const QUALIFIED_SHARE_SENTENCE = 'On the qualified GB10 (driver 580.178.04) a GPU memory share is a best-effort, per-CUDA-process MPS limit on cudaMalloc and managed memory, measured at a 1 GiB limit; managed memory also counts against the RAM limit, and pinned-host and ATS memory count only against the RAM limit.';
const escapedSentence = (sentence) => sentence.replace(/'/g, '&#39;');

test('X.unified-disclosure', () => {
    assert.ok(GPU_HELP.includes(UNIFIED_SENTENCE));
    const value = snapshot();
    value.gpu = { eligible: false, mode: 'unavailable', assurance: 'none', memoryModel: 'unified', unifiedMemory: { ramLimitCoversGpuAllocations: false, gpuMemoryBound: 'admission-only', assurance: 'advisory' } };
    const html = renderHardwareLimits(value, reconcileDrafts(value.agents, value.token));
    assert.ok(html.includes(escapedSentence(UNIFIED_SENTENCE)));
    assert.ok(html.includes('RAM limits on this Box do not cover GPU device memory (advisory)'));
    assert.match(html, /data-hardware-field="smPercent"[^>]* disabled/);
    assert.match(html, /data-hardware-field="vramPercent"[^>]* disabled/);
    // Absent unifiedMemory still discloses, labelled advisory.
    delete value.gpu.unifiedMemory;
    assert.ok(renderHardwareLimits(value, reconcileDrafts(value.agents, value.token)).includes('RAM limits on this Box do not cover GPU device memory (advisory)'));
    // The assurance label comes from the server value.
    const line = (unifiedMemory) => { value.gpu.unifiedMemory = unifiedMemory; return renderHardwareLimits(value, reconcileDrafts(value.agents, value.token)); };
    assert.ok(line({ ramLimitCoversGpuAllocations: false, assurance: 'advisory' }).includes('do not cover GPU device memory (advisory)'));
    // The assurance label passes through from the server value.
    assert.ok(line({ ramLimitCoversGpuAllocations: false, assurance: 'test-label' }).includes('do not cover GPU device memory (test-label)'));
    // Fail safe: a partial or malformed unifiedMemory still shows the line, labelled advisory.
    assert.ok(line({ assurance: 'advisory' }).includes('do not cover GPU device memory (advisory)'));
    for (const malformed of [{}, null, 'x', { assurance: '' }, { assurance: 7 }]) assert.ok(line(malformed).includes('do not cover GPU device memory (advisory)'));
    // Hidden only when the server states a RAM limit does cover GPU device memory.
    assert.doesNotMatch(line({ ramLimitCoversGpuAllocations: true, assurance: 'advisory' }), /do not cover GPU device memory/);
    // The assurance value is escaped.
    const hostile = line({ ramLimitCoversGpuAllocations: false, assurance: '<img src=x onerror=alert(1)>' });
    assert.ok(hostile.includes('(&lt;img src=x onerror=alert(1)&gt;)'));
    assert.ok(!hostile.includes('<img'));
    // No per-Box line for a dedicated or unspecified memory model.
    for (const memoryModel of ['dedicated', undefined]) {
        value.gpu = { eligible: false, mode: 'unavailable', assurance: 'none', memoryModel };
        assert.doesNotMatch(renderHardwareLimits(value, reconcileDrafts(value.agents, value.token)), /do not cover GPU device memory/);
    }
});

test('X.dedicated-labels-unchanged', () => {
    const agent = { ref, configured: { cpus: 1.5, gpu: { smPercent: 25, vramPercent: 50 } }, declared: { memory: '1g' }, effective: { cpus: 1.5, memoryBytes: 1024 ** 3, gpu: { smPercent: 25, vramPercent: 50, vramMiB: 3072 } }, containers: [] };
    const value = { ok: true, token: { epoch: '1'.repeat(32), revision: 1 }, gate: { state: 'on', prepared: true, controllers: ['cpu', 'memory'] }, envelope: { cpus: 8, memoryBytes: 8 * 1024 ** 3 },
        gpu: { eligible: true, mode: 'mps-shared', assurance: 'best-effort', memoryModel: 'dedicated', name: 'NVIDIA GeForce RTX 3060 Laptop GPU', deviceMemoryBytes: 6442450944, daemonStatus: 'stopped', serverDefault: null }, agents: [agent] };
    const html = renderHardwareLimits(value, reconcileDrafts(value.agents, value.token));
    assert.ok(html.includes('GPU VRAM %'));
    assert.ok(html.includes('% of physical VRAM'));
    assert.deepEqual([...html.matchAll(/<label class="hardware-limit-field">([^<]*)</g)].map((match) => match[1]), ['CPU cores', 'RAM %', 'GPU SM %', 'GPU VRAM %']);
    assert.doesNotMatch(html, /do not cover GPU device memory|GPU memory %/);
    // R8: the panel at the base revision rendered this snapshot to 4203 bytes with this digest. The only permitted
    // differences are the appended unified-memory and qualified-share help paragraphs inside the GPU help list.
    const appended = `<p>${escapedSentence(UNIFIED_SENTENCE)}</p>`;
    const shareAppended = `<p>${escapedSentence(QUALIFIED_SHARE_SENTENCE)}</p>`;
    assert.equal(html.split(appended).length, 2);
    assert.equal(html.split(shareAppended).length, 2);
    const base = html.replace(appended, '').replace(shareAppended, '');
    assert.equal(base.length, 4203);
    assert.equal(crypto.createHash('sha256').update(base).digest('hex'), '73460c7efd66296c27049bcab40eaa3c66cb2592a710d7fa1906bb4f34ff2365');
});

test('X.unified-labels', () => {
    // The Phase 1 sentence stays and the qualified-share sentence is appended after it.
    assert.equal(GPU_HELP.at(-2), UNIFIED_SENTENCE);
    assert.equal(GPU_HELP.at(-1), QUALIFIED_SHARE_SENTENCE);
    const kinds = [
        { kind: 'device', apis: ['cudaMalloc', 'cuMemAlloc'], ramLimit: false, gpuShare: true },
        { kind: 'managed', apis: ['cudaMallocManaged'], ramLimit: true, gpuShare: true },
        { kind: 'pinned-host', apis: ['cudaHostAlloc', 'cuMemHostAlloc'], ramLimit: true, gpuShare: false },
        { kind: 'pageable', apis: ['malloc'], ramLimit: true, gpuShare: false },
    ];
    const value = snapshot();
    value.agents[0].configured = { cpus: 1.5, gpu: { smPercent: 50, vramPercent: 25 } };
    value.agents[0].effective = { cpus: 1.5, gpu: { smPercent: 50, vramPercent: 25, vramMiB: 30625 } };
    value.gpu = { eligible: true, mode: 'mps-shared', assurance: 'best-effort', memoryModel: 'unified', deviceMemoryBytes: null, daemonStatus: 'ready',
        shareBasis: { kind: 'unified-pool', bytes: 122500 * 1024 ** 2, source: 'box-envelope' },
        unifiedMemory: { ramLimitCoversGpuAllocations: false, gpuMemoryBound: 'mps-per-process', assurance: 'best-effort', enforcement: 'cooperative', allocationKinds: kinds } };
    let html = renderHardwareLimits(value, reconcileDrafts(value.agents, value.token));
    assert.deepEqual([...html.matchAll(/<label class="hardware-limit-field">([^<]*)</g)].map((match) => match[1]), ['CPU cores', 'RAM %', 'GPU SM %', 'GPU memory % (unified pool)']);
    assert.doesNotMatch(html, /GPU VRAM %|physical VRAM|physical device memory/);
    assert.doesNotMatch(html, /data-hardware-field="(?:smPercent|vramPercent)"[^>]* disabled/);
    assert.ok(html.includes('50% GPU SM / 25% of the unified memory pool'));
    assert.ok(html.includes('GPU memory percentage uses the unified memory pool (the Box memory envelope); applied rows show the resolved bytes per CUDA process.'));
    assert.ok(html.includes('GPU memory share: best-effort, per CUDA process (MPS); cooperative: a process that drops the MPS environment is not limited'));
    assert.deepEqual([...html.matchAll(/<li data-kind="([^"]*)">([^<]*)<\/li>/g)].map((match) => [match[1], match[2]]), [
        ['device', 'cudaMalloc device memory: GPU share only'],
        ['managed', 'Managed memory: RAM limit and GPU share (counted against both)'],
        ['pinned-host', 'Pinned host memory: RAM limit only'],
        ['pageable', 'ATS (pageable) memory used by the GPU: RAM limit only'],
    ]);
    assert.doesNotMatch(html, /do not cover GPU device memory/);
    assert.ok(html.includes(escapedSentence(QUALIFIED_SHARE_SENTENCE)));
    // Unknown or malformed kinds render no row, and hostile text is not echoed.
    value.gpu.unifiedMemory.allocationKinds = [{ kind: '<img src=x>' }, null, { kind: 'managed' }];
    html = renderHardwareLimits(value, reconcileDrafts(value.agents, value.token));
    assert.equal([...html.matchAll(/<li data-kind=/g)].length, 1);
    assert.ok(!html.includes('<img'));
    // Ineligible unified keeps the Phase 1 line, label and disabled inputs.
    value.gpu = { eligible: false, mode: 'unavailable', assurance: 'none', memoryModel: 'unified', unifiedMemory: { ramLimitCoversGpuAllocations: false, gpuMemoryBound: 'admission-only', assurance: 'advisory', allocationKinds: kinds } };
    html = renderHardwareLimits(value, reconcileDrafts(value.agents, value.token));
    assert.ok(html.includes('RAM limits on this Box do not cover GPU device memory (advisory)'));
    assert.ok(html.includes('GPU VRAM %'));
    assert.doesNotMatch(html, /GPU memory % \(unified pool\)|unified memory pool|data-kind=/);
    assert.match(html, /data-hardware-field="vramPercent"[^>]* disabled/);
});

test('X.u13-disclosure', () => {
    assert.match(AUTHORITY_HELP, /workspace master key and forge administrator cookie\/CSRF/);
    assert.match(AUTHORITY_HELP, /accepted for v1/);
    assert.ok(renderHardwareLimits(snapshot(), reconcileDrafts(snapshot().agents, token())).includes(AUTHORITY_HELP));
});

test('panel ignores a response after unload and retains bounded structured errors', async () => {
    let complete;
    const presenter = panel({ read: () => new Promise((resolve) => { complete = resolve; }) });
    const pending = presenter.refresh();
    presenter.afterUnload();
    complete(snapshot(2));
    await pending;
    assert.deepEqual(presenter.snapshot.token, token());
    const error = new HardwareLimitsError({ error: 'dependency_blocked', message: 'Blocked', fix: 'Repair', hardwareOutcome: { state: 'blocked' }, committed: true, token: token(3) }, 424);
    assert.equal(error.fix, 'Repair');
    assert.deepEqual(error.hardwareOutcome, { state: 'blocked' });
    assert.equal(error.committed, true);
});

test('a server CAS conflict between fresh read and POST preserves the draft', async () => {
    let revision = 1;
    const api = {
        read: async () => snapshot(revision),
        set: async () => { revision = 2; throw new HardwareLimitsError({ error: 'revision_conflict', message: 'Changed concurrently.' }, 409); },
    };
    const presenter = panel(api);
    presenter.edit({ dataset: { hardwareField: 'memoryPercent', agentIndex: '0' }, value: '50' });
    await presenter.action({ hardwareAction: 'save', agentIndex: '0' });
    assert.equal(presenter.drafts.get(ref).memoryPercent, '50');
    assert.equal(presenter.drafts.get(ref).conflict, true);
    assert.deepEqual(presenter.drafts.get(ref).reviewToken, token(2));
    assert.deepEqual(presenter.snapshot.token, token(2));
});

test('expired session proof retains HTTP authority status for hiding the editor', async () => {
    const api = createHardwareLimitsApi({ expectedOrigin: 'https://box.test', fetchImplementation: async () => response({ ok: false, error: 'not_authenticated' }, 401) });
    await assert.rejects(api.clear(token(), ref), (error) => hardwareAccessDenied(error) && error.status === 401);
});

function validatePolicy(limits) {
    return validateAgentLimits({ agentRef: ref, limits, installedRefs: new Set([ref]), envelope: { cpus: 8, memoryBytes: 8 * 1024 ** 3 },
        capabilities: { gate: 'on', controllers: ['cpu', 'memory', 'pids'], gpu: { eligible: true, memoryModel: 'dedicated', imageUserKnown: true, deviceMemoryBytes: 6 * 1024 ** 3 } } });
}

test('GPU drafts use the actual store percentage schema and CPU edits preserve configured GPU policy', async () => {
    let authoritative = snapshot();
    authoritative.gpu.eligible = true;
    authoritative.agents[0].configured = { cpus: 1.5, memoryPercent: 25, gpu: { smPercent: 50, vramPercent: 50 } };
    const posts = [];
    const api = {
        read: async () => structuredClone(authoritative),
        set: async (_token, agentRef, limits) => {
            assert.equal(agentRef, ref);
            const validated = validatePolicy(limits);
            assert.deepEqual(validateAgentEntry(limits), validated.entry);
            assert.equal(validated.gpuBytes, 3072 * 1024 ** 2);
            posts.push(limits);
            authoritative = { ...authoritative, token: token(2), agents: [{ ...authoritative.agents[0], configured: validated.entry }] };
            return { ok: true };
        },
    };
    const presenter = panel(api, authoritative);
    assert.equal(presenter.drafts.get(ref).smPercent, '50');
    assert.equal(presenter.drafts.get(ref).vramPercent, '50');
    presenter.edit({ dataset: { hardwareField: 'cpus', agentIndex: '0' }, value: '3.25' });
    await presenter.action({ hardwareAction: 'save', agentIndex: '0' });
    assert.deepEqual(posts, [{ cpus: 3.25, memoryPercent: 25, gpu: { smPercent: 50, vramPercent: 50 } }]);
    assert.deepEqual(presenter.snapshot.agents[0].configured.gpu, { smPercent: 50, vramPercent: 50 });
    assert.throws(() => validateAgentEntry({ gpuShare: { smPercent: 50, vramMiB: 3072 } }), /unsupported field/);
    const html = renderHardwareLimits(presenter.snapshot, presenter.drafts);
    assert.match(html, /GPU VRAM %/);
    assert.match(html, /50% of physical VRAM/);
    assert.doesNotMatch(html, /data-hardware-field="vramMiB"/);
});

test('an old poll cannot revert a completed Save or restore an editor after access denial', async () => {
    let finishOld;
    let reads = 0;
    let authoritative = snapshot();
    const api = { read: () => ++reads === 1 ? new Promise((resolve) => { finishOld = resolve; }) : Promise.resolve(structuredClone(authoritative)),
        set: async (_token, _ref, limits) => { validatePolicy(limits); authoritative = snapshot(2); authoritative.agents[0].configured = limits; return { ok: true }; } };
    const presenter = panel(api);
    const oldPoll = presenter.refresh();
    presenter.edit({ dataset: { hardwareField: 'cpus', agentIndex: '0' }, value: '3.25' });
    await presenter.action({ hardwareAction: 'save', agentIndex: '0' });
    finishOld(snapshot());
    await oldPoll;
    assert.deepEqual(presenter.snapshot.token, token(2));
    assert.equal(presenter.drafts.get(ref).cpus, '3.25');
    const denied = panel({ read: () => new Promise((resolve) => { finishOld = resolve; }) });
    const pending = denied.refresh();
    denied.reportError(new HardwareLimitsError({ error: 'admin_required' }, 403));
    finishOld(snapshot(2));
    await pending;
    assert.equal(denied.snapshot, null);
    assert.equal(denied.drafts.size, 0);
});

for (const status of [207, 409]) {
    test(`partial Apply ${status} retains all exact outcomes before authoritative reload`, async () => {
        let finishReload;
        let gets = 0;
        const outcome = { ok: false, error: status === 409 ? 'revision_conflict' : 'partial_apply', message: 'Some operations remain incomplete.', token: token(2),
            results: [{ key: 'one', state: 'applied' }, { key: 'two', state: 'blocked', problem: { blockedBy: { ref: 'repo/root' }, rootCause: { ref: 'repo/root', reason: 'Memory missing.', fix: 'Repair delegation.' } } },
                { key: 'three', state: 'refused', problem: { reason: 'GPU missing.', fix: 'Repair GPU.' } }, { key: 'four', state: 'pending' }],
            expandedContainers: ['two', 'three'], pendingContainers: ['four'] };
        const api = createHardwareLimitsApi({ expectedOrigin: 'https://box.test', fetchImplementation: async (url, options = {}) => {
            if (url === '/auth/token') return response({ ok: true, adminControl: { origin: 'https://box.test', csrfToken: 'fresh' } });
            if (options.method === 'POST') return response(outcome, status);
            if (++gets === 1) return response(snapshot());
            return { ok: true, status: 200, json: () => new Promise((resolve) => { finishReload = resolve; }) };
        } });
        const presenter = panel(api);
        presenter.content = { innerHTML: '' };
        const pending = presenter.action({ hardwareAction: 'apply-all' });
        for (let tick = 0; !finishReload && tick < 50; tick += 1) await new Promise((resolve) => setTimeout(resolve, 1));
        assert.ok(finishReload);
        assert.deepEqual(presenter.results, outcome.results);
        assert.deepEqual(presenter.expandedContainers, outcome.expandedContainers);
        assert.deepEqual(presenter.pendingContainers, outcome.pendingContainers);
        for (const state of ['applied', 'blocked', 'refused', 'pending']) assert.ok(presenter.content.innerHTML.includes(state));
        assert.match(presenter.content.innerHTML, /Repair delegation/);
        assert.match(presenter.content.innerHTML, /Still pending: four/);
        assert.match(presenter.content.innerHTML, /Coordinated instances: two, three/);
        finishReload(snapshot(2));
        await pending;
        assert.deepEqual(presenter.results, outcome.results);
        assert.deepEqual(presenter.snapshot.token, token(2));
    });
}


test('exact alias rows show profile-specific desired values beside applied limits', () => {
    const value = snapshot();
    value.agents[0].containers[0].effective = { cpus: 2.25, memoryBytes: 3 * 1024 ** 3 };
    const presenter = panel({}, value);
    const html = renderHardwareLimits(value, presenter.drafts);
    assert.match(html, /Desired 2.25 CPU cores, 3.0 GiB RAM/);
    assert.match(html, /Applied/);
    assert.match(html, /1.0 GiB/);
});

test('a successful poll arriving during edits preserves the current input DOM', async () => {
    let finish;
    const presenter = panel({ read: () => new Promise((resolve) => { finish = resolve; }) });
    let renders = 0;
    presenter.content = { set innerHTML(_) { renders += 1; } };
    const request = presenter.refresh();
    presenter.edit({ dataset: { hardwareField: 'cpus', agentIndex: '0' }, value: '2' });
    finish(snapshot(2));
    await request;
    assert.equal(renders, 0);
    assert.equal(presenter.drafts.get(ref).cpus, '2');
    assert.deepEqual(presenter.snapshot.token, token(1));
    presenter.edit({ dataset: { hardwareField: 'cpus', agentIndex: '0' }, value: '2.25' });
    assert.equal(presenter.drafts.get(ref).cpus, '2.25');
});

for (const error of [new Error('Network unavailable'), new HardwareLimitsError({ error: 'store_unreadable', message: 'Store unreadable' }, 503)]) {
    test(`a failed poll preserves dirty input DOM while displaying ${error.message}`, async () => {
        let fail;
        const presenter = panel({ read: () => new Promise((_resolve, reject) => { fail = reject; }) });
        let renders = 0; const notice = { textContent: '', hidden: true };
        presenter.content = { set innerHTML(_) { renders += 1; }, querySelector: () => notice };
        const request = presenter.refresh();
        presenter.edit({ dataset: { hardwareField: 'cpus', agentIndex: '0' }, value: '2' });
        fail(error); await request;
        assert.equal(renders, 0); assert.equal(notice.textContent, error.message); assert.equal(notice.hidden, false);
        presenter.edit({ dataset: { hardwareField: 'cpus', agentIndex: '0' }, value: '2.25' });
        assert.equal(presenter.drafts.get(ref).cpus, '2.25');
    });
}
