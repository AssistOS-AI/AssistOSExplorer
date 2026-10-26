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
        dom: null,
        async evaluate() { if (!this.dom) throw new Error('no DOM configured'); return structuredClone(this.dom); },
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
    assert.deepEqual(state.evidence.webchatTab, { observationStartedAt: 't1', tabId: TAB_A, status: 'observed', streamRequests: 2, distinctTabIds: 1, navigationsAfterBinding: 0, sessionId: null, submissionAttempts: [{ at: 't2' }], pairs: [] });
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

// --- the stable message pair of a submission, read passively from the WebChat DOM ---
const SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER_SESSION = '1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LINK = `${BASE}/base-agent-additional-server/roboTeamAgent/3001/conversation-skills/default-robot/${SESSION}`;
const dom = ({ href = LINK, hidden = false, user = [], assistant = [], link = { hidden, href } } = {}) => ({ link, user, assistant });
function bound(extra = {}) {
    const clock = { value: 0 };
    const state = createCopilotDiagnostics({ webchatTab: true, now: () => `t${++clock.value}`, ...extra });
    const page = fakePage();
    state.observeWebchatTab(page, { baseURL: BASE, agent: 'roboTeamAgent' });
    page.request(streamUrl(TAB_A));
    return { state, page };
}
const snapshot = (state, page, value) => { page.dom = value; return state.snapshotWebchatMessages(page, { baseURL: BASE }); };
const resolve = (state, page, value) => { page.dom = value; return state.pairResolved(page, { baseURL: BASE }); };

test('the owned session is captured from a valid settings link and nothing else of the link is kept', async () => {
    const { state, page } = bound();
    await snapshot(state, page, dom({ user: [uuid(1)], assistant: [uuid(2)] }));
    assert.equal(state.evidence.webchatTab.sessionId, SESSION);
    assert.doesNotMatch(JSON.stringify(state.evidence), /conversation-skills|default-robot|127\.0\.0\.1|http/);
    // Robot ids need not be UUIDs; they are only validated.
    for (const robot of ['abc', 'a1-b2-c3', 'x'.repeat(64)]) {
        const fresh = bound();
        await snapshot(fresh.state, fresh.page, dom({ href: LINK.replace('default-robot', robot) }));
        assert.equal(fresh.state.evidence.webchatTab.sessionId, SESSION);
    }
});

test('a hidden, foreign, malformed or unstructured settings link is rejected and never bound', async () => {
    const bad = {
        'hidden': dom({ hidden: true }),
        'absent': dom({ link: null }),
        'foreign origin': dom({ href: LINK.replace(BASE, 'https://evil.example') }),
        'other port': dom({ href: LINK.replace(BASE, 'http://127.0.0.1:18081') }),
        'wrong prefix': dom({ href: LINK.replace('roboTeamAgent/3001', 'roboTeamAgent/3002') }),
        'wrong segment': dom({ href: LINK.replace('conversation-skills', 'conversation-settings') }),
        'extra segment': dom({ href: `${LINK}/extra` }),
        'missing session': dom({ href: LINK.replace(`/${SESSION}`, '') }),
        'session not v4': dom({ href: LINK.replace(SESSION, '0a1b2c3d-4e5f-1a6b-8c7d-9e0f1a2b3c4d') }),
        'session not a uuid': dom({ href: LINK.replace(SESSION, 'not-a-session') }),
        'robot too short': dom({ href: LINK.replace('default-robot', 'ab') }),
        'robot uppercase': dom({ href: LINK.replace('default-robot', 'Default-Robot') }),
        'robot too long': dom({ href: LINK.replace('default-robot', 'x'.repeat(65)) }),
        'query value': dom({ href: `${LINK}?token=secret` }),
        'fragment': dom({ href: `${LINK}#x` }),
        'not a url': dom({ href: 'not a url' }),
        'malformed message id': dom({ user: ['not-a-uuid'] }),
        'duplicated message id': dom({ assistant: [uuid(2), uuid(2)] }),
    };
    for (const [name, value] of Object.entries(bad)) {
        const { state, page } = bound();
        await assert.rejects(snapshot(state, page, value), /message pair is (?:unbound|invalid|ambiguous)/, name);
        assert.equal(state.evidence.webchatTab.sessionId, null, `${name}: nothing bound`);
    }
});

test('exactly one new stable user and assistant pair is recorded with its times, and nothing else', async () => {
    const { state, page } = bound();
    await snapshot(state, page, dom({ user: [uuid(1)], assistant: [uuid(2)] }));
    state.beforeSubmit();
    state.submitted();
    // Zero new ids: still pending. The optimistic bubbles carry no id and are not in the id lists at all.
    assert.equal(await resolve(state, page, dom({ user: [uuid(1)], assistant: [uuid(2)] })), false);
    assert.throws(() => state.requirePairResolved(), /held/);
    assert.equal(await resolve(state, page, dom({ user: [uuid(1), uuid(3)], assistant: [uuid(2), uuid(4)] })), true);
    state.requirePairResolved();
    assert.deepEqual(state.evidence.webchatTab.pairs, [{ userMessageId: uuid(3), assistantMessageId: uuid(4), beforeSubmitAt: 't2', pairObservedAt: 't4' }]);
    assert.doesNotMatch(JSON.stringify(state.evidence), /conversation-skills|http|127\.0\.0\.1|message text/);
    // A second submission snapshots everything that exists, including the first pair.
    await snapshot(state, page, dom({ user: [uuid(1), uuid(3)], assistant: [uuid(2), uuid(4)] }));
    state.beforeSubmit();
    assert.equal(await resolve(state, page, dom({ user: [uuid(1), uuid(3), uuid(5)], assistant: [uuid(2), uuid(4), uuid(6)] })), true);
    assert.equal(state.evidence.webchatTab.pairs.length, 2);
    assert.equal(state.evidence.webchatTab.pairs[1].userMessageId, uuid(5));
});

test('a delayed id stays pending within the bounds, and an ambiguous or mismatched pair holds', async () => {
    const mk = async () => { const x = bound(); await snapshot(x.state, x.page, dom({ user: [uuid(1)], assistant: [uuid(2)] })); x.state.beforeSubmit(); return x; };
    // The user id appears first, the assistant id later: pending, then resolved.
    let { state, page } = await mk();
    assert.equal(await resolve(state, page, dom({ user: [uuid(1), uuid(3)], assistant: [uuid(2)] })), false);
    assert.equal(await resolve(state, page, dom({ user: [uuid(1), uuid(3)], assistant: [uuid(2), uuid(4)] })), true);
    // At the bound without a pair: held, and nothing was fabricated.
    ({ state, page } = await mk());
    assert.equal(await resolve(state, page, dom({ user: [uuid(1), uuid(3)], assistant: [uuid(2)] })), false);
    assert.throws(() => state.requirePairResolved(), /held: no single new user and assistant pair/);
    assert.deepEqual(state.evidence.webchatTab.pairs, []);
    // More than one new id of either kind is ambiguous at once; a new pair is never chosen among several.
    ({ state, page } = await mk());
    await assert.rejects(resolve(state, page, dom({ user: [uuid(1), uuid(3), uuid(5)], assistant: [uuid(2), uuid(4)] })), /ambiguous: 2 new user and 1 new assistant/);
    ({ state, page } = await mk());
    await assert.rejects(resolve(state, page, dom({ user: [uuid(1), uuid(3)], assistant: [uuid(2), uuid(4), uuid(6)] })), /ambiguous: 1 new user and 2 new assistant/);
    // A changed session, a hidden link or an earlier id that vanished is a mismatch.
    ({ state, page } = await mk());
    await assert.rejects(resolve(state, page, dom({ href: LINK.replace(SESSION, OTHER_SESSION), user: [uuid(1), uuid(3)], assistant: [uuid(2), uuid(4)] })), /mismatched: the conversation session changed/);
    ({ state, page } = await mk());
    await assert.rejects(resolve(state, page, dom({ hidden: true, user: [uuid(1), uuid(3)], assistant: [uuid(2), uuid(4)] })), /unbound/);
    ({ state, page } = await mk());
    await assert.rejects(resolve(state, page, dom({ user: [uuid(3)], assistant: [uuid(2), uuid(4)] })), /inconsistent/);
    // A submission time that was not taken before the click cannot anchor a pair.
    const unanchored = bound();
    await snapshot(unanchored.state, unanchored.page, dom({ user: [], assistant: [] }));
    await assert.rejects(resolve(unanchored.state, unanchored.page, dom({ user: [uuid(3)], assistant: [uuid(4)] })), /unanchored: the submission time/);
});

test('a document change between the snapshot and the pair fails, and a session change across submissions fails', async () => {
    const { state, page } = bound();
    await snapshot(state, page, dom({ user: [uuid(1)], assistant: [uuid(2)] }));
    state.beforeSubmit();
    page.navigate();
    await assert.rejects(resolve(state, page, dom({ user: [uuid(1), uuid(3)], assistant: [uuid(2), uuid(4)] })), /tab identity is invalidated/);
    assert.deepEqual(state.evidence.webchatTab.pairs, []);
    const next = bound();
    await snapshot(next.state, next.page, dom({}));
    await assert.rejects(snapshot(next.state, next.page, dom({ href: LINK.replace(SESSION, OTHER_SESSION) })), /mismatched: the conversation session changed/);
    // Without a bound stream there is no tab identity to attribute a pair to.
    const unbound = createCopilotDiagnostics({ webchatTab: true });
    unbound.observeWebchatTab(fakePage(), { baseURL: BASE, agent: 'roboTeamAgent' });
    await assert.rejects(snapshot(unbound, Object.assign(fakePage(), {}), dom({})), /tab identity is missing/);
});

test('non-opted callers keep their contract: the pair methods are inert or refused', async () => {
    const plain = createCopilotDiagnostics({ now: () => 'fixed' });
    await assert.rejects(plain.snapshotWebchatMessages(fakePage(), { baseURL: BASE }), /not enabled/);
    assert.equal(await plain.pairResolved(fakePage(), { baseURL: BASE }), true);
    plain.requirePairResolved();
    plain.beforeSubmit();
    assert.deepEqual(Object.keys(plain.evidence), ['firstTerminalError', 'submissions', 'replyOutcome']);
});

test('the real WebChat DOM selectors ignore optimistic bubbles, task wrappers and the typing indicator and honor the link state', { timeout: 60_000 }, async (t) => {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const html = ({ hiddenLink = false, extra = '', idLess = '' } = {}) => `<base href="${BASE}/"><main>
        <a id="sessionSettingsLink" ${hiddenLink ? 'hidden' : ''} href="${LINK.replace(BASE, '')}">Conversation skills</a>
        <div id="chatList">
          <div class="wa-message in" data-message-id="${uuid(2)}"><div class="wa-message-bubble">intro text</div></div>
          <div class="wa-message out" data-message-id="${uuid(1)}"><div class="wa-message-bubble">earlier prompt text</div></div>
          ${idLess}${extra}
        </div></main>`;
    // Optimistic and live bubbles carry no id; a task wrapper has only data-task-id; the typing indicator is excluded even with an id.
    const noise = `<div class="wa-message out"><div class="wa-message-bubble">optimistic prompt without an id</div></div>
          <div class="wa-message in"><div class="wa-message-bubble">live bubble without an id</div></div>
          <div class="wa-message in wa-task-item" data-task-id="t1" data-assistant-message-id="${uuid(9)}"><div class="wa-message-bubble"></div></div>
          <div class="wa-message in wa-typing" data-message-id="${uuid(8)}"></div>`;
    const state = createCopilotDiagnostics({ webchatTab: true, now: () => 'now' });
    // The page double supplies the bound stream; the DOM is the real one (a base element gives it the configured origin).
    const double = fakePage();
    state.observeWebchatTab(double, { baseURL: BASE, agent: 'roboTeamAgent' });
    double.request(streamUrl(TAB_A));
    double.evaluate = (fn) => page.evaluate(fn);
    await page.setContent(html());
    await state.snapshotWebchatMessages(double, { baseURL: BASE });
    assert.equal(state.evidence.webchatTab.sessionId, SESSION);
    state.beforeSubmit();
    await page.setContent(html({ idLess: noise }));
    assert.equal(await state.pairResolved(double, { baseURL: BASE }), false, 'id-less bubbles, the task wrapper and the typing indicator add nothing');
    // A hidden pending assistant anchor that carries a stable id counts; a user id is still missing.
    await page.setContent(html({ idLess: noise, extra: `<div class="wa-message in" hidden data-message-id="${uuid(4)}"><div class="wa-message-bubble"></div></div>` }));
    assert.equal(await state.pairResolved(double, { baseURL: BASE }), false, 'only the pending assistant anchor is new');
    await page.setContent(html({ idLess: noise, extra: `<div class="wa-message out" data-message-id="${uuid(3)}"></div><div class="wa-message in" hidden data-message-id="${uuid(4)}"><div class="wa-message-bubble"></div></div>` }));
    assert.equal(await state.pairResolved(double, { baseURL: BASE }), true, 'the pending anchor and the new user id form one pair');
    assert.equal(state.evidence.webchatTab.pairs[0].assistantMessageId, uuid(4));
    assert.equal(state.evidence.webchatTab.pairs[0].userMessageId, uuid(3));
    await page.setContent(html({ hiddenLink: true }));
    const later = createCopilotDiagnostics({ webchatTab: true });
    const laterPage = fakePage();
    later.observeWebchatTab(laterPage, { baseURL: BASE, agent: 'roboTeamAgent' });
    laterPage.request(streamUrl(TAB_A));
    laterPage.evaluate = (fn) => page.evaluate(fn);
    await assert.rejects(later.snapshotWebchatMessages(laterPage, { baseURL: BASE }), /session settings link is not shown/);
});

test('the semantic-routing cases snapshot before the attempt time and wait for the pair within the existing poll budget', async () => {
    const { readFileSync } = await import('node:fs');
    const spec = readFileSync(new URL('../specs/70-copilot-semantic-routing.spec.mjs', import.meta.url), 'utf8');
    const send = spec.slice(spec.indexOf('async function sendAndWaitForReply'), spec.indexOf("test.describe('AKU memory"));
    const snapshotAt = send.indexOf('.snapshotWebchatMessages(page, { baseURL: smokeConfig.baseURL })');
    assert.ok(snapshotAt > send.indexOf('fill(prompt)') && snapshotAt < send.indexOf('.beforeSubmit();'), 'snapshot precedes the attempt time');
    assert.ok(send.indexOf('.beforeSubmit();') < send.indexOf("locator('#send').click()"));
    assert.match(send, /pairResolved\(page, \{ baseURL: smokeConfig\.baseURL \}\)\) return texts\.join/);
    assert.match(send, /if \(replySeen\) diagnostics\.get\(page\)\.requirePairResolved\(\);\s+diagnostics\.get\(page\)\.timedOut\(\)/);
    assert.equal((send.match(/replied\(\)/g) || []).length, 1, 'the reply is recorded once, as before');
    assert.match(send, /const polls = Math\.ceil\(timeoutMs \/ 3_000\)/);
    assert.doesNotMatch(send, /setTimeout|timeout:\s*\d/, 'no new timeout');
});

test('one id seen in both roles is rejected early, in the snapshot and in the new pair', async () => {
    const { state, page } = bound();
    await assert.rejects(snapshot(state, page, dom({ user: [uuid(1)], assistant: [uuid(1)] })), /ambiguous: a stable message id is used in both roles/);
    assert.equal(state.evidence.webchatTab.sessionId, null, 'nothing was bound');
    const mk = async () => { const x = bound(); await snapshot(x.state, x.page, dom({ user: [uuid(1)], assistant: [uuid(2)] })); x.state.beforeSubmit(); return x; };
    // The same new id as the user and the assistant message: not a pair.
    let sample = await mk();
    await assert.rejects(resolve(sample.state, sample.page, dom({ user: [uuid(1), uuid(3)], assistant: [uuid(2), uuid(3)] })), /used in both roles/);
    assert.deepEqual(sample.state.evidence.webchatTab.pairs, []);
    // An earlier user id that now also appears as an assistant message, and the reverse.
    sample = await mk();
    await assert.rejects(resolve(sample.state, sample.page, dom({ user: [uuid(1), uuid(3)], assistant: [uuid(2), uuid(1)] })), /used in both roles/);
    sample = await mk();
    await assert.rejects(resolve(sample.state, sample.page, dom({ user: [uuid(1), uuid(2)], assistant: [uuid(2), uuid(4)] })), /used in both roles/);
});

test('only earlier user ids must persist: a vanished assistant anchor is allowed and a vanished user message fails', async () => {
    const mk = async () => {
        const x = bound();
        await snapshot(x.state, x.page, dom({ user: [uuid(1), uuid(3)], assistant: [uuid(2), uuid(4)] }));
        x.state.beforeSubmit();
        return x;
    };
    // A completed silent slash command keeps only its input: its assistant anchor is removed by the product.
    let sample = await mk();
    assert.equal(await resolve(sample.state, sample.page, dom({ user: [uuid(1), uuid(3), uuid(5)], assistant: [uuid(2), uuid(6)] })), true);
    assert.deepEqual(sample.state.evidence.webchatTab.pairs.map((p) => [p.userMessageId, p.assistantMessageId]), [[uuid(5), uuid(6)]]);
    // Every earlier assistant id gone is still fine; the pending state is unaffected.
    sample = await mk();
    assert.equal(await resolve(sample.state, sample.page, dom({ user: [uuid(1), uuid(3)], assistant: [] })), false);
    assert.equal(await resolve(sample.state, sample.page, dom({ user: [uuid(1), uuid(3), uuid(5)], assistant: [uuid(6)] })), true);
    // A vanished earlier user message is an inconsistent history and fails.
    sample = await mk();
    await assert.rejects(resolve(sample.state, sample.page, dom({ user: [uuid(3), uuid(5)], assistant: [uuid(2), uuid(4), uuid(6)] })), /inconsistent: an earlier user message disappeared/);
});
