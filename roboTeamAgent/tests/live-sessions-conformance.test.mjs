import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { authHeader, routerFetch } from './helpers/router-signed.mjs';
import { startHttpFixture } from './helpers/live-sessions-http-fixture.mjs';
import { SOURCE_BASE, URL_BASE, liveSessionsScenario } from './helpers/live-sessions-scenario.mjs';
import { comparableFixture, liveSessionsFixture } from './helpers/generate-live-sessions-fixture.mjs';
import { frameViolation, rowViolation } from '../server/live-sessions/contract.mjs';

// Producer conformance. RoboTeam's real HTTP output is consumed by Explorer's
// real Live Sessions consumer: the payload normalizer, the message and stop
// clients and the stream view, imported from the owning Explorer checkout. The
// RoboTeam view page script runs on the same frames.
const EXPLORER = new URL('../../explorer/IDE-plugins/live-sessions/', import.meta.url);
const explorerApi = await import(new URL('live-sessions-api.js', EXPLORER).href);
const { LiveSessionStreamView } = await import(new URL('components/live-session-stream-view/live-session-stream-view.js', EXPLORER).href);
const SOURCE = Object.freeze({ agent: 'roboTeamAgent', contributionType: 'live-sessions-source', label: 'RoboTeam',
    liveSessions: { version: 1, base: SOURCE_BASE } });
const FIXTURE = new URL('./fixtures/live-sessions-producer-payload.json', import.meta.url);
const USER = () => ({ 'x-ploinky-auth-info': authHeader('member-1', ['user']) });
const ADMIN = () => ({ 'x-ploinky-auth-info': authHeader('owner-1', ['admin']) });

async function scenarioServer(t, options = {}) {
    const scenario = liveSessionsScenario();
    const fixture = await startHttpFixture(t, { liveSessions: scenario.registry, streamLifetimeMs: 100, ...options });
    // Explorer requests the declared source path; the Router strips the agent
    // prefix before RoboTeam sees it. Every request is signed for this user.
    const fetchAs = (headers) => async (url, init = {}) => {
        const target = String(url);
        assert.ok(target.startsWith(URL_BASE), target);
        return routerFetch(`${fixture.baseUrl}${target.slice(URL_BASE.length)}`, { method: init.method || 'GET',
            headers: { ...(init.headers || {}), ...headers() }, ...(init.body === undefined ? {} : { body: init.body }), signal: init.signal });
    };
    return { ...scenario, ...fixture, fetchAs };
}

function sseFrames(text) {
    return text.split('\n\n').filter((block) => block && !block.startsWith(':')).map((block) => {
        const frame = { id: null };
        for (const line of block.split('\n')) {
            const index = line.indexOf(': ');
            frame[line.slice(0, index)] = line.slice(index + 2);
        }
        return { id: frame.id, event: frame.event, data: frame.data };
    });
}

async function streamText(fixture, id, headers) {
    const response = await routerFetch(`${fixture.baseUrl}/api/live-sessions/${id}/stream`, { headers: headers() });
    assert.equal(response.status, 200);
    return response.text();
}

test('every produced list payload passes Explorer\'s real normalizer and the producer contract', async (t) => {
    const server = await scenarioServer(t);
    for (const [name, headers, count] of [['admin', ADMIN, 9], ['owner', USER, 5]]) {
        const response = await server.fetchAs(headers)(SOURCE_BASE);
        const payload = await response.json();
        const rows = explorerApi.normalizeAgentSessionsPayload(payload, SOURCE);
        assert.equal(rows.length, count, name);
        for (const row of payload.sessions) assert.equal(rowViolation(row, 'roboTeamAgent'), null, `${name} ${row.id}`);
    }
    // aggregateLiveSessions (the modal's path) keeps every row and reports no error.
    const [result] = await explorerApi.aggregateLiveSessions([SOURCE], { fetchImpl: server.fetchAs(ADMIN) });
    assert.equal(result.error, undefined);
    assert.equal(result.rows.length, 9);
    const statuses = new Set(result.rows.map((row) => row.status));
    for (const status of ['running', 'waiting', 'reconnecting', 'finished', 'failed', 'stopped', 'lost']) assert.ok(statuses.has(status), status);
});

test('the recorded producer payload passes both validators and still matches what the producer emits', async () => {
    const recorded = JSON.parse(await fs.readFile(FIXTURE, 'utf8'));
    assert.equal(explorerApi.normalizeAgentSessionsPayload(recorded.list, SOURCE).length, recorded.list.sessions.length);
    for (const row of recorded.list.sessions) assert.equal(rowViolation(row, 'roboTeamAgent'), null, row.title);
    assert.ok(recorded.streams.length >= 3);
    for (const stream of recorded.streams) {
        for (const frame of stream.frames) assert.equal(frameViolation(frame.event, JSON.parse(frame.data)), null, `${stream.title} ${frame.event}`);
    }
    // Rows and frames, ignoring ids, timestamps and URLs. Regenerate with
    // node tests/helpers/generate-live-sessions-fixture.mjs after an intended change.
    assert.deepEqual(comparableFixture(liveSessionsFixture()), comparableFixture(recorded));
});

// A minimal DOM for Explorer's stream view and the RoboTeam view page script.
class FakeNode {
    constructor(tag) { Object.assign(this, { tagName: tag, children: [], textContent: '', className: '', hidden: false, parent: null,
        scrollTop: 0, scrollHeight: 0, value: '', disabled: false }); }
    appendChild(child) { child.parent = this; this.children.push(child); return child; }
    replaceChildren() { this.children = []; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
    addEventListener() {}
    removeEventListener() {}
}

class FakeEventSource {
    static CLOSED = 2;
    static instances = [];
    constructor(url) { this.url = url; this.listeners = new Map(); this.readyState = 1; this.closed = false; FakeEventSource.instances.push(this); }
    addEventListener(name, listener) { this.listeners.set(name, [...(this.listeners.get(name) || []), listener]); }
    close() { this.closed = true; this.readyState = 2; }
    emit(name, data) { for (const listener of this.listeners.get(name) || []) listener({ data }); }
}

function mountStreamView(row) {
    const nodes = { '.live-session-output': new FakeNode('pre'), '.live-session-stream-status': new FakeNode('span'),
        '.live-session-message-form': new FakeNode('form'), textarea: new FakeNode('textarea'), button: new FakeNode('button') };
    const element = { isConnected: true, querySelector: (selector) => nodes[selector] };
    const view = new LiveSessionStreamView(element, () => {});
    view.afterRender();
    view.updateSession(row, SOURCE);
    return { view, nodes, stream: FakeEventSource.instances.at(-1) };
}

test('produced SSE frames render in Explorer\'s real stream view without a contract error', async (t) => {
    const previous = { document: globalThis.document, EventSource: globalThis.EventSource };
    globalThis.document = { createElement: (tag) => new FakeNode(tag), cookie: '' };
    globalThis.EventSource = FakeEventSource;
    t.after(() => Object.assign(globalThis, previous));
    const server = await scenarioServer(t);
    const rows = explorerApi.normalizeAgentSessionsPayload(await (await server.fetchAs(ADMIN)(SOURCE_BASE)).json(), SOURCE);
    for (const row of rows) {
        const frames = sseFrames(await streamText(server, row.id, ADMIN));
        assert.ok(frames.length > 0, row.title);
        const { view, nodes, stream } = mountStreamView(row);
        assert.equal(stream.url, `${SOURCE_BASE}/${row.id}/stream`);
        let expected = '';
        for (const frame of frames) {
            assert.equal(frameViolation(frame.event, JSON.parse(frame.data)), null, `${row.title} ${frame.event}`);
            stream.emit(frame.event, frame.data);
            assert.doesNotMatch(nodes['.live-session-stream-status'].textContent, /invalid data/u, `${row.title} ${frame.event}`);
            if (frame.event === 'output') expected += JSON.parse(frame.data).text;
            if (frame.event === 'output') assert.ok(frame.id && /^\d+$/u.test(frame.id), 'every output frame has an id');
        }
        assert.equal(nodes['.live-session-output'].children.map((node) => node.textContent).join(''), expected, row.title);
        if (row.exit) {
            assert.equal(frames.at(-1).event, 'exit');
            assert.equal(nodes['.live-session-stream-status'].textContent, `${row.status}: ${row.exit.reason}`);
            assert.equal(stream.closed, true);
        } else {
            assert.equal(frames.at(-1).event, 'status');
        }
        view.afterUnload();
    }
});

test('Explorer\'s real message and stop clients understand every producer response', async (t) => {
    const server = await scenarioServer(t);
    const ownerFetch = server.fetchAs(USER);
    const rows = explorerApi.normalizeAgentSessionsPayload(await (await ownerFetch(SOURCE_BASE)).json(), SOURCE);
    const own = rows.find((row) => row.id === server.runs.robotTask);
    assert.equal(own.capabilities.message, true);
    for (const outcome of ['delivered', 'queued', 'rejected', 'run_ended', 'unknown']) {
        server.outcomes.set(`message ${outcome}`, outcome);
        assert.equal(await explorerApi.messageAgentSession(SOURCE, own, `message ${outcome}`, { fetchImpl: ownerFetch }), outcome);
    }
    await explorerApi.stopAgentSession(SOURCE, own, { fetchImpl: ownerFetch });
    assert.equal(server.outcomes.get('stopped:Robot task · Builder'), true);
    const adminRows = explorerApi.normalizeAgentSessionsPayload(await (await server.fetchAs(ADMIN)(SOURCE_BASE)).json(), SOURCE);
    const phase = adminRows.find((row) => row.id === server.runs.phase);
    await explorerApi.stopAgentSession(SOURCE, phase, { fetchImpl: server.fetchAs(ADMIN) });
    assert.equal(server.outcomes.get('stopped:Workflow phase · Release'), true);
});

test('the RoboTeam view page script renders the same frames as text only', async (t) => {
    const server = await scenarioServer(t);
    const page = await routerFetch(`${server.baseUrl}/live-sessions/${server.runs.robotTask}`, { headers: USER() });
    const html = await page.text();
    const script = /<script>([\s\S]*?)<\/script>/u.exec(html)[1];
    const nodes = { output: new FakeNode('pre'), status: new FakeNode('span') };
    FakeEventSource.instances.length = 0;
    const context = vm.createContext({
        document: { getElementById: (id) => nodes[id], createElement: (tag) => new FakeNode(tag), baseURI: `http://h${URL_BASE}/` },
        location: { pathname: `${URL_BASE}/live-sessions/${server.runs.robotTask}` },
        EventSource: FakeEventSource, TextEncoder, URL, setTimeout, Date, JSON,
    });
    vm.runInContext(script, context);
    const stream = FakeEventSource.instances.at(-1);
    assert.equal(stream.url, `http://h${URL_BASE}/api/live-sessions/${server.runs.robotTask}/stream`);
    const frames = sseFrames(await streamText(server, server.runs.robotTask, USER));
    for (const frame of frames) {
        stream.emit(frame.event, frame.data);
        assert.doesNotMatch(nodes.status.textContent, /invalid data/u, frame.event);
    }
    const rendered = nodes.output.children;
    assert.ok(rendered.length >= 6);
    assert.deepEqual([...new Set(rendered.map((node) => node.className))].sort(),
        ['live-assistant', 'live-error', 'live-output', 'live-status', 'live-user']);
    assert.equal(rendered.map((node) => node.textContent).join(''), frames.filter((frame) => frame.event === 'output').map((frame) => JSON.parse(frame.data).text).join(''));
    assert.equal(nodes.status.textContent, 'Working on step 2');
});
