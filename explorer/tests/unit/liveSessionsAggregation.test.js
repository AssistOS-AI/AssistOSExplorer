import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { aggregateIdePlugins } from '../../utils/ide-plugins.mjs';
import { normalizeRuntimePlugins } from '../../utils/pluginUtils.core.js';
import { isOwnedLiveSessionUrl } from '../../utils/liveSessionSource.mjs';
import {
    aggregateLiveSessions, discoverLiveSessionSources, messageAgentSession,
    navigateLiveSessionWindow, normalizeAgentSessionsPayload, stopAgentSession,
} from '../../IDE-plugins/live-sessions/live-sessions-api.js';
import { LiveSessionStreamView } from '../../IDE-plugins/live-sessions/components/live-session-stream-view/live-session-stream-view.js';

const source = {
    agent: 'roboTeamAgent', id: 'runs', label: 'Runs', contributionType: 'live-sessions-source',
    liveSessions: { version: 1, base: '/base-agent-additional-server/roboTeamAgent/3001/api/live-sessions' },
};
const row = (changes = {}) => ({
    id: 'ls_test', source: 'roboTeamAgent', kind: 'robot-task', title: 'Task', detail: '',
    cwdDisplay: '', access: 'ro', status: 'running', isOwner: true, ownerLabel: 'Owner', ownerState: 'verified',
    viewerCount: 0, startedAt: 1000, lastActivityAt: 2000, exit: null,
    capabilities: { watch: true, input: false, stop: true, message: true }, attach: { mode: 'event-stream' },
    ...changes,
});
const payload = (rows = [row()]) => ({ ok: true, version: 1, sessions: rows });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('componentless sources survive the real server and browser pipeline; unsafe owning-agent URLs are dropped in both', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'live-sources-'));
    const invalid = [
        '/other/api', '/roboTeamAgent/../api', '/roboTeamAgent/%2fapi', '/roboTeamAgent/%25252fapi',
        '/base-agent-additional-server/roboTeamAgent/0/api', '/base-agent-additional-server/roboTeamAgent/065536/api',
        '/base-agent-additional-server/roboTeamAgent/65536/api', '/roboTeamAgent/api?q=1', '/roboTeamAgent/api#x',
        '//evil/roboTeamAgent/api', 'http://h/roboTeamAgent/api', '/roboTeamAgent\\api', '/roboTeamAgent//api',
        '/roboTeamAgent/%252e%252e/api', '/roboTeamAgent/%252525252fapi', '/roboTeamAgent/%zz',
    ];
    try {
        for (const [index, base] of [source.liveSessions.base, '/roboTeamAgent/api/live-sessions', ...invalid].entries()) {
            const folder = path.join(directory, 'roboTeamAgent', 'IDE-plugins', `source-${index}`);
            await fs.mkdir(folder, { recursive: true });
            await fs.writeFile(path.join(folder, 'config.json'), JSON.stringify({
                pluginCategory: 'application', id: `source-${index}`, location: ['live-sessions:source'],
                contributionType: 'live-sessions-source', label: 'Runs', liveSessions: { version: 1, base },
                agent: 'other',
            }));
        }
        const catalog = await aggregateIdePlugins(directory);
        assert.equal(catalog.application['live-sessions:source'].length, 2);
        const normalized = normalizeRuntimePlugins(catalog);
        const entries = normalized.application['live-sessions:source'];
        assert.equal(entries.length, 2);
        assert.ok(entries.every((entry) => entry.agent === 'roboTeamAgent' && entry.contributionType === 'live-sessions-source' && !entry.component));
        for (const base of invalid) {
            assert.equal(isOwnedLiveSessionUrl(base, 'roboTeamAgent'), false, base);
            assert.equal(normalizeRuntimePlugins({ application: { 'live-sessions:source': [{ ...entries[0], liveSessions: { version: 1, base } }] } }).application['live-sessions:source'].length, 0, base);
        }
        assert.equal(normalizeRuntimePlugins({ application: { 'live-sessions:source': [{ ...entries[0], id: ['runs'] }] } }).application['live-sessions:source'].length, 0, 'array id must not coerce through the id pattern');
        assert.equal(discoverLiveSessionSources({ 'live-sessions:source': [...entries, entries[0]] }).length, 2);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('agent row URLs and capabilities stay within the declared agent and exact display contract', () => {
    const safe = row({ viewUrl: '/roboTeamAgent/view', transcriptUrl: '/base-agent-additional-server/roboTeamAgent/3001/logs/turn' });
    assert.equal(normalizeAgentSessionsPayload(payload([safe]), source)[0].viewUrl, safe.viewUrl);
    for (const changes of [
        { viewUrl: '/other/view' }, { transcriptUrl: '//evil/log' }, { viewUrl: '/roboTeamAgent/%252fview' },
        { principal: 'secret' }, { status: 'unknown' }, { ownerState: 'unknown' }, { exit: {} },
        { isOwner: false }, { attach: { mode: 'event-stream', token: 'secret' } },
        { capabilities: { watch: true, input: true, stop: true, message: true } },
        { status: 'finished', exit: { reason: 'finished' } },
    ]) assert.throws(() => normalizeAgentSessionsPayload(payload([row(changes)]), source), /Invalid/);
    const finished = row({ status: 'finished', exit: { reason: 'completed', code: 0 }, capabilities: { watch: true, input: false, stop: false, message: false } });
    assert.equal(normalizeAgentSessionsPayload(payload([finished]), source)[0].exit.code, 0);
    assert.throws(() => normalizeAgentSessionsPayload(payload([row(), row()]), source), /Duplicate/);
});

test('a hung source is aborted at five seconds while healthy sources render independently; non-admin never fetches shells', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const urls = [];
    const results = [];
    let hungSignal;
    const hung = { ...source, liveSessions: { version: 1, base: '/roboTeamAgent/hung' } };
    const operation = aggregateLiveSessions([source, hung], { admin: false, onResult: (result) => results.push(result), fetchImpl: async (url, options) => {
        urls.push(url);
        if (url.endsWith('/hung')) { hungSignal = options.signal; return new Promise(() => {}); }
        return response(payload());
    } });
    await turn();
    assert.equal(results.length, 1);
    assert.equal(results[0].rows.length, 1);
    t.mock.timers.tick(4999);
    assert.equal(hungSignal.aborted, false);
    t.mock.timers.tick(1);
    const complete = await operation;
    assert.equal(hungSignal.aborted, true);
    assert.ok(complete[1].error);
    assert.ok(urls.every((url) => !url.startsWith('/webtty')));
});

test('agent authorization refusals are empty; other failures retain independent source errors and modal-close abort', async () => {
    for (const status of [401, 403, 500]) {
        const [result] = await aggregateLiveSessions([source], { fetchImpl: async () => response({}, status) });
        assert.deepEqual(result.rows, []);
        assert.equal(Boolean(result.error), status === 500);
    }
    const controller = new AbortController();
    let signal;
    const operation = aggregateLiveSessions([source], { signal: controller.signal, fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
    controller.abort();
    await operation;
    assert.equal(signal.aborted, true);
});

test('message controls preserve exact outcomes and make one mutation with no automatic retry; foreign owners cannot message', async () => {
    let calls = 0;
    for (const [status, body, expected] of [[200, { delivery: 'delivered' }, 'delivered'], [200, { delivery: 'queued' }, 'queued'],
        [409, { error: 'rejected', detail: 'busy' }, 'rejected'], [409, { error: 'run_ended' }, 'run_ended'], [504, { error: 'delivery_unknown' }, 'unknown']]) {
        const outcome = await messageAgentSession(source, row(), 'Unicode π', { fetchImpl: async (url, options) => {
            calls += 1;
            assert.equal(url, `${source.liveSessions.base}/ls_test/messages`);
            assert.equal(options.credentials, 'same-origin');
            assert.deepEqual(JSON.parse(options.body), { message: 'Unicode π' });
            return response(body, status);
        } });
        assert.equal(outcome, expected);
    }
    assert.equal(calls, 5);
    await assert.rejects(messageAgentSession(source, row({ isOwner: false }), 'message', { fetchImpl: () => { calls += 1; } }));
    assert.equal(calls, 5);
    for (const message of ['', 'x'.repeat(32769)]) await assert.rejects(messageAgentSession(source, row(), message));
    await stopAgentSession(source, row(), { fetchImpl: async (url, options) => {
        assert.equal(url, `${source.liveSessions.base}/ls_test/stop`);
        assert.equal(options.body, '{}');
        return response({ ok: true });
    } });
});

class Element {
    constructor() { this.children = []; this.isConnected = true; this.value = ''; }
    appendChild(child) { this.children.push(child); child.remove = () => { this.children = this.children.filter((entry) => entry !== child); }; }
    replaceChildren() { this.children = []; }
    addEventListener() {}
    removeEventListener() {}
}

function streamEnvironment(t, changes = {}) {
    const previous = { document: globalThis.document, EventSource: globalThis.EventSource };
    t.after(() => Object.assign(globalThis, previous));
    const streams = [];
    class FakeStream {
        static CLOSED = 2;
        constructor(url) { this.url = url; this.handlers = {}; this.readyState = 0; streams.push(this); }
        addEventListener(name, callback) { this.handlers[name] = callback; }
        close() { this.closed = true; }
        event(name, data) { this.handlers[name]({ data: JSON.stringify(data) }); }
    }
    globalThis.EventSource = FakeStream;
    globalThis.document = { createElement: () => new Element() };
    const elements = new Map(['.live-session-output', '.live-session-stream-status', '.live-session-message-form', 'textarea', 'button'].map((key) => [key, new Element()]));
    const host = new Element();
    host.querySelector = (key) => elements.get(key);
    const view = new LiveSessionStreamView(host, () => {});
    view.afterRender();
    view.updateSession(row(changes), source);
    t.after(() => view.afterUnload());
    return { view, streams, elements };
}

test('stream stays inert and recovers after a 45-second outage without duplicating replay; unload cancels recovery', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const { view, streams, elements } = streamEnvironment(t, { isOwner: false, capabilities: { watch: true, input: false, stop: true, message: false } });
    assert.equal(elements.get('.live-session-message-form').hidden, true);
    streams[0].event('output', { text: '<img onerror="bad()">', style: 'output' });
    const text = elements.get('.live-session-output').children[0];
    assert.equal(text.textContent, '<img onerror="bad()">');
    assert.equal(text.children.length, 0);
    streams[0].readyState = 2;
    streams[0].onerror();
    t.mock.timers.tick(999);
    assert.equal(streams.length, 1);
    t.mock.timers.tick(1);
    assert.equal(streams.length, 2);
    assert.equal(elements.get('.live-session-output').children.length, 0);
    assert.ok(streams.every((stream) => stream.url === `${source.liveSessions.base}/ls_test/stream`));
    for (const delay of [2000, 4000, 8000, 15000, 15000]) {
        const stream = streams.at(-1);
        stream.readyState = 2;
        stream.onerror();
        t.mock.timers.tick(delay - 1);
        assert.equal(streams.at(-1), stream);
        t.mock.timers.tick(1);
        assert.notEqual(streams.at(-1), stream);
    }
    assert.equal(Date.now(), 46000);
    const recovered = streams.at(-1);
    recovered.onopen();
    streams[0].event('output', { text: 'stale duplicate', style: 'output' });
    recovered.event('output', { text: '<img onerror="bad()">', style: 'output' });
    assert.deepEqual(elements.get('.live-session-output').children.map((node) => node.textContent), ['<img onerror="bad()">']);
    recovered.readyState = 2;
    recovered.onerror();
    const count = streams.length;
    view.afterUnload();
    t.mock.timers.tick(60000);
    assert.equal(streams.length, count);
    assert.ok(streams.every((stream) => stream.closed));
});

test('CLOSED stream recovery stops at ten elapsed minutes and does not restart after teardown', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const { view, streams, elements } = streamEnvironment(t);
    for (const delay of [1000, 2000, 4000, 8000, ...Array(39).fill(15000)]) {
        const stream = streams.at(-1);
        stream.readyState = 2;
        stream.onerror();
        t.mock.timers.tick(delay);
    }
    assert.equal(Date.now(), 601000);
    assert.equal(view.stream, null);
    assert.match(elements.get('.live-session-stream-status').textContent, /Disconnected.*reopen from Live Sessions/);
    const count = streams.length;
    t.mock.timers.tick(600000);
    assert.equal(streams.length, count);
    view.afterUnload();
    assert.equal(view.retryTimer, null);
});

test('stream replay reset, output retention and terminal exit close controls and owned stream', (t) => {
    const { view, streams, elements } = streamEnvironment(t);
    assert.equal(elements.get('.live-session-message-form').hidden, false);
    for (let index = 0; index < 2050; index += 1) streams[0].event('output', { text: 'x', style: 'assistant' });
    assert.equal(view.parts.length, 2048);
    streams[0].event('replay-truncated', {});
    assert.equal(view.parts.length, 0);
    streams[0].event('status', { status: 'waiting', text: 'Permission requested. Answer in WebChat.' });
    assert.match(elements.get('.live-session-stream-status').textContent, /WebChat/);
    streams[0].event('exit', { status: 'stopped', exit: { reason: 'owner_stop' } });
    assert.equal(streams[0].closed, true);
    assert.equal(elements.get('.live-session-message-form').hidden, true);
    assert.equal(view.ended, true);
});

test('agent pop-out validates its owning route and navigates the isolated tab without referrer', () => {
    let anchor;
    const popup = { opener: null, document: { createElement: () => (anchor = { click() {} }), body: { appendChild() {} } }, close() { this.closed = true; } };
    assert.equal(navigateLiveSessionWindow(popup, '/roboTeamAgent/view', source.agent), popup);
    assert.equal(anchor.href, '/roboTeamAgent/view');
    assert.equal(anchor.rel, 'noopener noreferrer');
    assert.equal(anchor.referrerPolicy, 'no-referrer');
    assert.equal(navigateLiveSessionWindow(popup, '/other/view', source.agent), null);
    assert.equal(popup.closed, true);
});
