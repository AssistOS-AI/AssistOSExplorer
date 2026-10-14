import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    aggregateLiveSessions, normalizeAgentSessionsPayload,
} from '../../IDE-plugins/live-sessions/live-sessions-api.js';
import { LiveSessionStreamView } from '../../IDE-plugins/live-sessions/components/live-session-stream-view/live-session-stream-view.js';
import { LiveSessionsModal } from '../../IDE-plugins/live-sessions/components/live-sessions-modal/live-sessions-modal.js';

const fixtureDirectory = path.resolve(import.meta.dirname, '../fixtures');
const vendoredPath = path.join(fixtureDirectory, 'live-sessions-roboteam-producer.json');

const fixture = JSON.parse(fs.readFileSync(vendoredPath, 'utf8'));
const source = {
    agent: fixture.source.agent, id: 'runs', label: 'Runs', contributionType: 'live-sessions-source',
    liveSessions: fixture.source.liveSessions,
};
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const turn = () => new Promise((resolve) => setImmediate(resolve));
const list = () => normalizeAgentSessionsPayload(fixture.list, source);
const ENDED = ['finished', 'failed', 'stopped', 'lost'];

test('vendored producer fixture matches its recorded provenance', () => {
    const readme = fs.readFileSync(path.join(fixtureDirectory, 'live-sessions-roboteam-producer.README.md'), 'utf8');
    const recorded = readme.match(/\| SHA-256 \| ([0-9a-f]{64}) \|/)?.[1];
    assert.ok(recorded, 'README records a SHA-256');
    assert.match(readme, /\| Source commit \| 085b6f0d \|/);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(vendoredPath)).digest('hex'), recorded);
});

test('every producer row is accepted by the real normalizer with every kind, status and owner state present', () => {
    const rows = list();
    assert.equal(rows.length, 9);
    assert.deepEqual(new Set(rows.map((entry) => entry.kind)), new Set(['copilot-task', 'robot-task', 'workflow-phase', 'copilot-turn']));
    assert.deepEqual(new Set(rows.map((entry) => entry.status)), new Set(['running', 'waiting', 'reconnecting', 'finished', 'failed', 'stopped', 'lost']));
    assert.deepEqual(new Set(rows.map((entry) => entry.ownerState)), new Set(['verified', 'system', 'unverified']));
    for (const entry of rows) {
        assert.equal(entry.exit === null, !ENDED.includes(entry.status), `${entry.title}: exit is set exactly when ended`);
        assert.equal(entry.capabilities.watch, true);
        assert.equal(entry.attach.mode, 'event-stream');
    }
});

test('the aggregation path used by the modal accepts the producer payload through the declared source', async () => {
    const urls = [];
    const results = await aggregateLiveSessions([source], { fetchImpl: async (url) => { urls.push(url); return response(fixture.list); } });
    assert.deepEqual(urls, [source.liveSessions.base]);
    assert.equal(results[0].error, undefined);
    assert.equal(results[0].rows.length, 9);
});

class Element {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.textContent = ''; this.isConnected = true; this.value = ''; }
    appendChild(child) {
        this.children.push(...(child.tagName === '#fragment' ? child.children : [child]));
        child.remove = () => { this.children = this.children.filter((entry) => entry !== child); };
        return child;
    }
    replaceChildren(...children) { this.children = children.flatMap((child) => child.tagName === '#fragment' ? child.children : [child]); }
    addEventListener() {}
    removeEventListener() {}
    querySelector() { return null; }
    contains() { return true; }
    focus() {}
}

function streamEnvironment(t, row) {
    const previous = { document: globalThis.document, EventSource: globalThis.EventSource };
    t.after(() => Object.assign(globalThis, previous));
    const streams = [];
    class FakeStream {
        static CLOSED = 2;
        constructor(url) { this.url = url; this.handlers = {}; this.readyState = 0; streams.push(this); }
        addEventListener(name, callback) { this.handlers[name] = callback; }
        close() { this.closed = true; }
    }
    globalThis.EventSource = FakeStream;
    globalThis.document = { createElement: (tag) => new Element(tag) };
    const elements = new Map(['.live-session-output', '.live-session-stream-status', '.live-session-message-form', 'textarea', 'button'].map((key) => [key, new Element()]));
    const host = new Element();
    host.querySelector = (key) => elements.get(key);
    const view = new LiveSessionStreamView(host, () => {});
    view.afterRender();
    view.updateSession(row, source);
    t.after(() => view.afterUnload());
    return { view, stream: streams[0], elements };
}

test('every recorded stream replays through the real stream view without invalid data, rendering text only', (t) => {
    const rows = list();
    const byTitle = new Map(rows.map((entry) => [entry.title, entry]));
    assert.equal(fixture.streams.length, 3);
    for (const recorded of fixture.streams) {
        const row = byTitle.get(recorded.title);
        assert.ok(row, `a list row matches stream "${recorded.title}"`);
        const { view, stream, elements } = streamEnvironment(t, row);
        const status = elements.get('.live-session-stream-status');
        const output = elements.get('.live-session-output');
        assert.equal(stream.url, `${source.liveSessions.base}/${row.id}/stream`);
        const texts = [];
        let exitFrame = null;
        for (const frame of recorded.frames) {
            assert.equal(typeof frame.data, 'string');
            stream.handlers[frame.event]({ data: frame.data });
            assert.doesNotMatch(status.textContent, /invalid data/i, `${recorded.title} frame ${frame.id ?? frame.event}`);
            if (frame.event === 'output') texts.push(JSON.parse(frame.data).text);
            if (frame.event === 'exit') exitFrame = JSON.parse(frame.data);
        }
        assert.deepEqual(output.children.map((node) => node.textContent), texts, `${recorded.title}: every output frame rendered via textContent`);
        assert.ok(output.children.every((node) => node.children.length === 0 && node.innerHTML === undefined));
        if (recorded.frames.at(-1).event === 'status') {
            assert.equal(status.textContent, JSON.parse(recorded.frames.at(-1).data).text);
            assert.equal(view.ended, false);
            assert.ok(!stream.closed, 'a status frame leaves the live stream open');
        } else {
            assert.ok(exitFrame, `${recorded.title} ends with an exit frame`);
            assert.equal(status.textContent, `${exitFrame.status}: ${exitFrame.exit.reason}`);
            assert.equal(view.ended, true);
            assert.equal(stream.closed, true);
            assert.equal(elements.get('.live-session-message-form').hidden, true);
        }
    }
});

test('an ended producer agent row stays watchable in the real modal and keeps its stream view across polls', async (t) => {
    const previous = new Map(['document', 'assistOS', 'fetch'].map((key) => [key, globalThis[key]]));
    t.after(() => { for (const [key, value] of previous) globalThis[key] = value; });
    globalThis.document = { cookie: '', createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element('#fragment') };
    const mounted = [];
    const presenter = { form: {}, updateSession(updated) { this.row = updated; }, afterUnload() { this.unloaded = true; } };
    globalThis.assistOS = {
        user: { roles: ['user'] },
        workspace: { appPlugins: { 'live-sessions:source': [source] } },
        UI: {
            createElement(name) {
                mounted.push(name);
                return { element: { deref: () => ({ presenterReadyPromise: Promise.resolve(), renderCompletePromise: Promise.resolve(), webSkelPresenter: presenter }) } };
            },
        },
    };
    globalThis.fetch = async () => response(fixture.list);
    const elements = new Map(['Status', 'List', 'Viewer', 'ViewerTitle', 'Frame'].map((name) => [`#liveSessions${name}`, new Element()]));
    const host = new Element();
    host.querySelector = (selector) => elements.get(selector);
    const modal = new LiveSessionsModal(host, () => {});
    t.after(() => modal.afterUnload());
    modal.afterRender();
    await turn();
    const ended = list().filter((entry) => ENDED.includes(entry.status));
    assert.deepEqual(ended.map((entry) => entry.status).sort(), ['failed', 'finished', 'lost', 'stopped']);
    for (const entry of ended) {
        const key = `${source.liveSessions.base}:${entry.id}`;
        const rendered = elements.get('#liveSessionsList').children.find((item) => item.dataset.sessionId === key);
        const actions = rendered.children.flatMap((child) => child.children).filter((button) => button.dataset?.sessionAction);
        assert.ok(actions.some((button) => button.dataset.sessionAction === 'attach' && button.textContent === 'Watch'), `${entry.status} row offers Watch`);
        assert.ok(!actions.some((button) => button.dataset.sessionAction === 'kill'), `${entry.status} row offers no stop`);
        await modal.performAction(key, 'attach');
        assert.equal(modal.viewerId, key);
        await modal.refresh();
        assert.equal(modal.viewerId, key, `${entry.status} view survives a poll`);
        assert.equal(modal.streamPresenter, presenter);
    }
    assert.equal(mounted.length, ended.length);
    assert.ok(mounted.every((name) => name === 'live-session-stream-view'));
});
