import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadinessDiagnostics, withFailureArtifact } from './readiness-diagnostics.mjs';
import { createCopilotDiagnostics } from './copilot-terminal-diagnostics.mjs';

const runtime = id => ({ agents: [{ agentName: 'gitAgent', containerId: id, instanceId: 'instance', enableGeneration: 'generation', projectedTarget: null }] });

test('failed collection, workspace binding and eligibility keep the actual last cause and fail', async () => {
    for (const [stage, message] of [['collection', 'collector unavailable'], ['workspace-binding', 'workspace bind mount mismatch'], ['eligibility', 'gitAgent must be eligible for the selected folder.']]) {
        const diagnostics = createReadinessDiagnostics({ now: () => 'timestamp' });
        const ready = diagnostics.sample(() => { if (stage !== 'eligibility') throw new Error(message); return runtime('a'); }, () => { throw new Error(message); });
        assert.equal(ready, false);
        assert.deepEqual(diagnostics.evidence.lastFailure, { at: 'timestamp', stage, message });
        const primary = new Error('original readiness assertion failed');
        let attached;
        await assert.rejects(withFailureArtifact(async () => { throw primary; }, async body => { attached = JSON.parse(body); }, diagnostics.evidence), error => error === primary);
        assert.equal(attached.lastFailure.message, message);
    }
});

test('definitively stale generation stops on the first collection and keeps its original error', async () => {
    const state = createReadinessDiagnostics();
    const error = new Error('Box outer container generation is not fresh enough for the release gate.');
    let calls = 0, artifact;
    await assert.rejects(withFailureArtifact(async () => {
        state.sample(() => { calls += 1; throw error; }, () => {});
    }, async body => { artifact = JSON.parse(body); }, state.evidence), value => value === error);
    assert.equal(calls, 1);
    assert.equal(artifact.lastFailure.message, error.message);
});

test('changing runtime identities, intermittent collector failures and missing samples never satisfy stability', () => {
    const state = createReadinessDiagnostics();
    for (let index = 0; index < 20; index += 1) assert.equal(state.sample(() => runtime(String(index)), () => {}), false);
    assert.equal(state.evidence.samples.length, 12);
    assert.equal(state.evidence.lastFailure.stage, 'unstable-signatures');
    assert.equal(state.sample(() => runtime('steady'), () => {}), false);
    assert.equal(state.sample(() => runtime('steady'), () => {}), false);
    assert.equal(state.sample(() => { throw new Error('collector failed'); }, () => {}), false);
    assert.equal(state.sample(() => runtime('steady'), () => {}), false);
    assert.equal(state.sample(() => runtime('steady'), () => {}), false);
    assert.equal(state.sample(() => runtime('steady'), () => {}), true);
    assert.equal(state.evidence.lastFailure, null);
    const noSamples = createReadinessDiagnostics();
    assert.equal(noSamples.evidence.stableSamples, 0);
    assert.equal(noSamples.evidence.lastFailure.stage, 'missing-stable-samples');
});

test('Playwright polling propagates stale collection failure immediately instead of retrying it', async () => {
    const { expect } = await import('@playwright/test');
    const state = createReadinessDiagnostics();
    let calls = 0;
    await assert.rejects(expect.poll(() => state.sample(() => {
        calls += 1; throw new Error('Box outer container generation is not fresh enough for the release gate.');
    }, () => {}), { timeout: 1000, intervals: [1] }).toBe(true), /not fresh enough/);
    assert.equal(calls, 1);
});

test('artifact write failure is visible, preserves primary failure, and cannot turn success green', async () => {
    const original = new Error('original failed assertion');
    const logs = [];
    await assert.rejects(withFailureArtifact(async () => { throw original; }, async () => { throw new Error('disk full'); }, {}, { report: text => logs.push(text) }), error => error === original);
    assert.equal(original.artifactFailure, 'disk full');
    assert.match(logs[0], /disk full/);
    await assert.rejects(withFailureArtifact(async () => true, async () => { throw new Error('disk full'); }, {}), /disk full/);
});

test('Copilot preserves first visible terminal error/time and rejects an error bubble as a reply', () => {
    let timestamp = 'first';
    const state = createCopilotDiagnostics({ now: () => timestamp });
    state.submitted();
    assert.throws(() => state.observe(['[input error] Marketplace recovery required']), /terminal.*failed/);
    timestamp = 'later';
    assert.throws(() => state.observe(['[error] later provider failure']));
    assert.deepEqual(state.evidence.firstTerminalError, { at: 'first', message: '[input error] Marketplace recovery required' });
    assert.equal(state.evidence.replyOutcome, 'terminal-error');
    assert.equal(state.evidence.submissions.length, 1);
    const valid = createCopilotDiagnostics();
    valid.observe(['Hello']); valid.submitted(); valid.observe(['COPILOT_CHAT_OK']); valid.replied();
    assert.equal(valid.evidence.replyOutcome, 'assistant-reply');
});

test('diagnostic payloads redact fabricated secrets before attachment or error messages', async () => {
    const previous = process.env.SMOKE_PASSWORD;
    process.env.SMOKE_PASSWORD = 'fabricated-private-secret';
    try {
        const state = createCopilotDiagnostics();
        assert.throws(() => state.observe(['[input error] fabricated-private-secret']), error => !error.message.includes(process.env.SMOKE_PASSWORD));
        const readiness = createReadinessDiagnostics();
        readiness.sample(() => { throw new Error('collector fabricated-private-secret'); }, () => {});
        let text;
        await withFailureArtifact(async () => false, async body => { text = body.toString(); }, readiness.evidence);
        assert.doesNotMatch(text, /fabricated-private-secret/);
    } finally { if (previous === undefined) delete process.env.SMOKE_PASSWORD; else process.env.SMOKE_PASSWORD = previous; }
});

// WebChat tab observation for the semantic-routing cases, with a page double that emits the same `request` events.
const TAB_A = '3f1c2a9e-5b7d-4c1a-9e2f-0a1b2c3d4e5f';
const TAB_B = '8d2e4f60-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const BASE = 'http://127.0.0.1:18080';
const streamUrl = (tabId, { base = BASE, path = '/webchat/stream', agent = 'roboTeamAgent' } = {}) => {
    const params = new URLSearchParams();
    if (tabId !== undefined) params.set('tabId', tabId);
    params.set('pageInstanceId', 'page-instance-secret');
    params.set('agent', agent);
    return `${base}${path}?${params}`;
};
function fakePage() {
    const handlers = { request: new Set(), framenavigated: new Set() };
    const main = { name: 'main' };
    return {
        main, handlers,
        get listenerCount() { return handlers.request.size + handlers.framenavigated.size; },
        mainFrame: () => main,
        on(event, handler) { handlers[event].add(handler); },
        off(event, handler) { handlers[event].delete(handler); },
        request(url, { frame = main, method = 'GET' } = {}) { for (const handler of [...handlers.request]) handler({ url: () => url, frame: () => frame, method: () => method }); },
        navigate(frame = main) { for (const handler of [...handlers.framenavigated]) handler(frame); },
    };
}
const observed = (extra = {}) => {
    const clock = { value: 0, events: [] };
    const state = createCopilotDiagnostics({ webchatTab: true, now: () => { clock.value += 1; clock.events.push(clock.value); return `t${clock.value}`; }, ...extra });
    const page = fakePage();
    state.observeWebchatTab(page, { baseURL: BASE, agent: 'roboTeamAgent' });
    return { state, page, clock };
};

test('WebChat tab observation captures the owned main-frame stream and records only the opaque id and times', () => {
    const { state, page } = observed();
    assert.equal(state.evidence.webchatTab.observationStartedAt, 't1');
    page.request(streamUrl(TAB_A));
    page.request(streamUrl(TAB_A));
    assert.equal(state.requireWebchatTab(), TAB_A);
    state.beforeSubmit();
    state.submitted();
    assert.deepEqual(state.evidence.webchatTab, { observationStartedAt: 't1', tabId: TAB_A, status: 'observed', streamRequests: 2, distinctTabIds: 1, navigationsAfterBinding: 0, submissionAttempts: [{ at: 't2' }] });
    assert.deepEqual(state.evidence.submissions, [{ at: 't3' }], 'the existing submission timing is unchanged and follows the attempt');
    assert.doesNotMatch(JSON.stringify(state.evidence), /page-instance-secret|127\.0\.0\.1|roboTeamAgent|\/webchat/, 'no URL, query value or route is recorded');
});

test('WebChat tab observation ignores foreign frames, origins, routes, agents and methods', () => {
    const { state, page } = observed();
    page.request(streamUrl(TAB_A), { frame: { name: 'child' } });
    page.request(streamUrl(TAB_A, { base: 'http://127.0.0.1:18081' }));
    page.request(streamUrl(TAB_A, { base: 'http://localhost:18080' }));
    page.request(streamUrl(TAB_A, { path: '/webchat/input' }));
    page.request(streamUrl(TAB_A, { path: '/webchat/stream/extra' }));
    page.request(streamUrl(TAB_A, { path: '/other/webchat/stream' }));
    page.request(streamUrl(TAB_A, { agent: 'otherAgent' }));
    page.request(streamUrl(TAB_A), { method: 'POST' });
    assert.equal(state.evidence.webchatTab.streamRequests, 0);
    assert.throws(() => state.requireWebchatTab(), /tab identity is missing/);
    assert.throws(() => state.beforeSubmit(), /missing/);
    assert.deepEqual(state.evidence.webchatTab.submissionAttempts, [], 'no attempt is recorded without a bound identity');
    page.request(streamUrl(TAB_B));
    assert.equal(state.requireWebchatTab(), TAB_B, 'only the owned route binds');
});

test('WebChat tab observation fails on a missing, malformed, changed or ambiguous identity', () => {
    for (const bad of [undefined, '', 'not-a-uuid', 'a'.repeat(300)]) {
        const { state, page } = observed();
        page.request(streamUrl(bad));
        assert.throws(() => state.requireWebchatTab(), /invalid/);
        page.request(streamUrl(TAB_A));
        assert.throws(() => state.requireWebchatTab(), /invalid/, 'a later valid id does not repair an invalid one');
    }
    const { state, page } = observed();
    page.request(streamUrl(TAB_A));
    assert.equal(state.requireWebchatTab(), TAB_A);
    page.request(streamUrl(TAB_B));
    assert.throws(() => state.requireWebchatTab(), /ambiguous: 2 owned stream request\(s\), 2 distinct/);
    assert.throws(() => state.beforeSubmit(), /ambiguous/);
    page.request(streamUrl(TAB_A));
    assert.throws(() => state.requireWebchatTab(), /ambiguous/, 'the last id is never silently taken');
    assert.equal(state.evidence.webchatTab.tabId, null);
    assert.equal(state.evidence.webchatTab.distinctTabIds, 2);
});

test('WebChat tab observation starts before connection setup and each attempt time precedes its click', () => {
    const order = [];
    const { state, page } = observed();
    // The page double has no click; the helper order is: bind, attempt time, click, existing submission time.
    page.request(streamUrl(TAB_A));
    const attempt = () => { state.beforeSubmit(); order.push(`attempt:${state.evidence.webchatTab.submissionAttempts.at(-1).at}`); order.push('click'); state.submitted(); };
    attempt();
    attempt();
    assert.deepEqual(order, ['attempt:t2', 'click', 'attempt:t4', 'click']);
    assert.deepEqual(state.evidence.webchatTab.submissionAttempts, [{ at: 't2' }, { at: 't4' }]);
    assert.equal(state.evidence.webchatTab.observationStartedAt, 't1', 'observation started before any stream request');
});

test('WebChat tab observation leaves no listener or capture after stop and refuses a second start', () => {
    const { state, page } = observed();
    assert.equal(page.listenerCount, 2, 'the request and navigation listeners are registered');
    assert.throws(() => state.observeWebchatTab(page, { baseURL: BASE, agent: 'roboTeamAgent' }), /already running/);
    state.stopWebchatTab();
    state.stopWebchatTab();
    assert.equal(page.listenerCount, 0, 'both listeners are removed at stop');
    page.request(streamUrl(TAB_A));
    assert.equal(state.evidence.webchatTab.streamRequests, 0);
    assert.throws(() => state.requireWebchatTab(), /missing/);
});

test('WebChat tab observation is opt-in and leaves other callers\' artifact shape unchanged', () => {
    const plain = createCopilotDiagnostics({ now: () => 'fixed' });
    assert.deepEqual(Object.keys(plain.evidence), ['firstTerminalError', 'submissions', 'replyOutcome']);
    plain.beforeSubmit();
    plain.submitted();
    assert.deepEqual(plain.evidence, { firstTerminalError: null, submissions: [{ at: 'fixed' }], replyOutcome: 'waiting' });
    assert.throws(() => plain.observeWebchatTab(fakePage(), { baseURL: BASE, agent: 'x' }), /not enabled/);
    assert.throws(() => plain.requireWebchatTab(), /not enabled/);
    assert.equal(JSON.stringify(plain.evidence).includes('webchatTab'), false);
});

test('the semantic-routing cases opt in, observe before sign-in and take the attempt time just before the click', async () => {
    const { readFileSync } = await import('node:fs');
    const spec = readFileSync(new URL('../specs/70-copilot-semantic-routing.spec.mjs', import.meta.url), 'utf8');
    assert.match(spec, /createCopilotDiagnostics\(\{ webchatTab: true \}\)/);
    const open = spec.slice(spec.indexOf('async function openCopilotWebchat'), spec.indexOf('async function waitForIntro'));
    assert.ok(open.indexOf('.observeWebchatTab(page, { baseURL: smokeConfig.baseURL, agent: smokeConfig.webchatAgent })') >= 0);
    assert.ok(open.indexOf('.observeWebchatTab(') < open.indexOf('await signIn('), 'the observer is registered before sign-in and navigation');
    const send = spec.slice(spec.indexOf('async function sendAndWaitForReply'), spec.indexOf("test.describe('AKU memory"));
    assert.ok(send.indexOf('.beforeSubmit();') > send.indexOf("fill(prompt)"));
    assert.ok(send.indexOf('.beforeSubmit();') < send.indexOf("locator('#send').click()"), 'the attempt is recorded before the click');
    assert.ok(send.indexOf("locator('#send').click()") < send.indexOf('.submitted();'), 'the existing submission time is unchanged after the click');
    assert.match(spec, /afterEach[\s\S]*stopWebchatTab\(\)[\s\S]*testInfo\.attach\('copilot-terminal_codex\.json'/, 'listeners are removed and the evidence attached afterwards');
    const other = readFileSync(new URL('../specs/05-copilot-folder-launch.spec.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(other, /webchatTab/, 'other callers do not opt in');
});

test('a main-frame document replacement after the binding invalidates it and is never rebound', () => {
    // Before the first stream: the sign-in redirects navigate freely.
    let { state, page } = observed();
    page.navigate(); page.navigate();
    page.request(streamUrl(TAB_A));
    assert.equal(state.requireWebchatTab(), TAB_A);
    assert.equal(state.evidence.webchatTab.navigationsAfterBinding, 0);
    // A same-id EventSource reconnect without a navigation keeps the binding.
    page.request(streamUrl(TAB_A));
    assert.equal(state.requireWebchatTab(), TAB_A);
    // A child-frame navigation is not the owned document.
    page.navigate({ name: 'child' });
    assert.equal(state.requireWebchatTab(), TAB_A);

    // A navigation after binding but before the submission: the attempt fails and no attempt time is recorded.
    page.navigate();
    assert.throws(() => state.beforeSubmit(), /invalidated/);
    assert.deepEqual(state.evidence.webchatTab.submissionAttempts, []);
    assert.equal(state.evidence.webchatTab.tabId, null);
    assert.equal(state.evidence.webchatTab.navigationsAfterBinding, 1);
    // The replaced document's new stream, even with the old or a new id, never rebinds.
    page.request(streamUrl(TAB_A));
    page.request(streamUrl(TAB_B));
    assert.throws(() => state.requireWebchatTab(), /invalidated/);
    assert.throws(() => state.beforeSubmit(), /invalidated/);

    // A navigation during the turn: the post-reply check fails.
    ({ state, page } = observed());
    page.request(streamUrl(TAB_A));
    state.beforeSubmit();
    state.submitted();
    page.navigate();
    assert.throws(() => state.requireWebchatTab(), /invalidated: 1 owned stream request\(s\), 1 distinct/);
    assert.deepEqual(state.evidence.webchatTab.submissionAttempts, [{ at: 't2' }], 'the earlier attempt is evidence, not repaired');
    state.stopWebchatTab();
    assert.equal(page.listenerCount, 0);
});
