import test from 'node:test';
import './helpers/isolated-ala-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationSessionStore } from '../src/lib/storage/conversationSessionStore.mjs';
import { HistoryManager } from '../src/repl/HistoryManager.mjs';
import { createWebchatDispatcher } from '../src/lib/webchat/webchatRuntime.mjs';

// The WebChat dispatcher hands the verified owner evidence of an envelope to the engine, and keeps a
// user stop apart from a shutdown (plan sections 9 and 10.2).
async function fixture(t, { stopTurn = null, onEnvelope = null } = {}) {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'achilles-webchat-owner-'));
    t.after(() => fs.rm(workingDir, { recursive: true, force: true }));
    const sessionStore = new ConversationSessionStore({ workingDir });
    const initialSession = await sessionStore.ensureCurrentSession();
    const seen = [];
    const engine = {
        async executeTurn({ sessionId, turnId, prompt, signal, owner, onEvent }) {
            const turn = await sessionStore.beginTurn({ sessionId, turnId, text: prompt });
            await onEvent({ type: 'turn-started', ...turn, turnId });
            const record = { prompt, owner, reason: null };
            seen.push(record);
            await new Promise((resolve) => signal.addEventListener('abort', () => { record.reason = signal.reason; resolve(); }, { once: true }));
            await sessionStore.completeTurn(sessionId, turn.assistantMessageId, 'stopped', { status: 'interrupted' });
            throw Object.assign(new Error('interrupted'), { name: 'AbortError' });
        },
        ...(stopTurn ? { stopTurn } : {}),
    };
    const verified = new Map();
    const coordinator = {
        onEnvelope: onEnvelope || (() => ({ event: '', done: Promise.resolve() })),
        evidenceFor: (message) => { verified.set(message.invocationToken, message); return { ok: true, principal: 'user:alice', grant: `grant-of-${message.invocationToken}` }; },
        close() {},
    };
    const runtime = { workingDir, sessionStore, initialSession, engine, historyManager: new HistoryManager({ workingDir }),
        skillCatalog: { getSkills: () => [] }, settings: {}, backgroundTasks: null };
    const written = [];
    const dispatcher = createWebchatDispatcher(runtime, { write: (line) => written.push(JSON.parse(line)), coordinator });
    t.after(() => dispatcher.cancel());
    return { dispatcher, seen, verified, coordinator, written };
}

const message = (text, token, tab = 'tabA') => JSON.stringify({ __webchatMessage: 1, version: 1, text, sourceTabId: tab, sourcePageInstanceId: 'page1',
    presentation: { visible: false }, invocation: { token } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

test('a signed envelope reaches the engine with its verified evidence; an unsigned message has none', async (t) => {
    const f = await fixture(t);
    f.dispatcher.receive(message('hello', 'tok-1'));
    await settle();
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0].owner.coordinator, f.coordinator);
    assert.deepEqual(f.seen[0].owner.evidence, { ok: true, principal: 'user:alice', grant: 'grant-of-tok-1' });
    // `freshest` serves the newest verified evidence of the principal, so a dropped stream is reattached with
    // a grant a later envelope supplied; a coordinator without evidenceFor yields no owner at all.
    assert.equal(f.seen[0].owner.freshest('user:alice').grant, 'grant-of-tok-1');
    f.dispatcher.receive(message('another tab', 'tok-9', 'tabB'));
    await settle();
    assert.equal(f.seen[0].owner.freshest('user:alice').grant, 'grant-of-tok-9');
    assert.equal(f.seen[0].owner.freshest('user:bob'), null);
    f.dispatcher.cancel();
    await f.dispatcher.drain();
    const unsigned = await fixture(t);
    unsigned.dispatcher.receive(message('local', ''));
    await settle();
    assert.equal(unsigned.seen[0].owner, undefined);
    unsigned.dispatcher.cancel();
    await unsigned.dispatcher.drain();
});

test('shutdown detaches while the user stop is a stop carrying its own evidence', async (t) => {
    const f = await fixture(t);
    f.dispatcher.receive(message('first', 'tok-1'));
    await settle();
    f.dispatcher.cancel();
    await f.dispatcher.drain();
    assert.equal(f.seen[0].reason.code, 'ROBOTEAM_DETACH', 'shutdown is a detach, not a stop');

    const g = await fixture(t);
    g.dispatcher.receive(message('second', 'tok-2'));
    await settle();
    g.dispatcher.receive(JSON.stringify({ __webchatControl: 1, type: 'stop', sourceTabId: 'tabA', sourcePageInstanceId: 'page1', invocation: { token: 'tok-stop' } }));
    await g.dispatcher.drain();
    const reason = g.seen[0].reason;
    assert.equal(reason.code, 'ROBOTEAM_STOP');
    assert.equal(reason.owner.evidence.grant, 'grant-of-tok-stop');
});

// ---- the chat's stop button and Escape (decision M-12 (b)) ----
const stopControl = (extra = {}) => JSON.stringify({ __webchatControl: 1, type: 'stop', sourceTabId: 'tabA', sourcePageInstanceId: 'page1', ...extra });

test('the stop button, the signed stop and Escape each stop the engine\'s turn as a control, never as a detach', async (t) => {
    const stops = [];
    const f = await fixture(t, { stopTurn: async (request) => { stops.push(request); return { delivered: true }; },
        onEnvelope: (message) => ({ event: message.event || '', done: Promise.resolve() }) });
    f.dispatcher.receive(message('first', 'tok-1'));
    await settle();
    // The Router's stop button: an unsigned control with no grant of its own.
    f.dispatcher.receive(stopControl());
    await settle();
    assert.equal(stops.length, 1);
    assert.equal(stops[0].owner, null, 'the Router\'s stop control carries no grant; the engine falls back to the user\'s newest unexpired one');
    assert.equal(typeof stops[0].turnId, 'string');
    // A signed stop envelope carries the user\'s grant for the worker stop.
    f.dispatcher.receive(JSON.stringify({ __webchatMessage: 1, version: 1, text: '', event: 'stop', sourceTabId: 'tabA', sourcePageInstanceId: 'page1',
        presentation: { visible: false }, invocation: { token: 'tok-stop' } }));
    await settle();
    assert.equal(stops.length, 2);
    assert.equal(stops[1].turnId, stops[0].turnId);
    assert.equal(stops[1].owner.evidence.grant, 'grant-of-tok-stop');
    // Escape is the same stop.
    f.dispatcher.receive('\x1b');
    await settle();
    assert.equal(stops.length, 3);
    assert.equal(stops[2].turnId, stops[0].turnId);
    // None of them aborted the turn here: the engine ends it when the worker confirms.
    assert.equal(f.seen[0].reason, null);
    // Shutdown still only detaches: no stop is sent.
    f.dispatcher.cancel();
    await f.dispatcher.drain();
    assert.equal(stops.length, 3);
    assert.equal(f.seen[0].reason.code, 'ROBOTEAM_DETACH');
});

test('a stop that is not delivered is told to the user and logged, and the turn keeps running', async (t) => {
    const logged = [];
    const original = console.error;
    console.error = (...args) => { logged.push(args.join(' ')); };
    t.after(() => { console.error = original; });
    const f = await fixture(t, { stopTurn: async () => ({ delivered: false, code: 'worker_stop_not_authorized', message: 'Stop not delivered: the worker needs your fresh authorization. The task may still be running; press stop again.' }) });
    f.dispatcher.receive(message('first', 'tok-1'));
    await settle();
    f.dispatcher.receive(stopControl());
    await settle();
    const errors = f.written.filter((envelope) => envelope.event === 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0].error, /Stop not delivered: the worker needs your fresh authorization/);
    assert.equal(errors[0].targetTabId, 'tabA');
    assert.ok(logged.some((line) => /webchat stop not delivered \(worker_stop_not_authorized\)/.test(line)), 'RoboTeam logs it');
    assert.equal(f.seen[0].reason, null, 'the turn was not aborted');
    // Pressing stop again reaches the engine again.
    f.dispatcher.receive(stopControl());
    await settle();
    assert.equal(f.written.filter((envelope) => envelope.event === 'error').length, 2);
});
