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
async function fixture(t) {
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
    };
    const verified = new Map();
    const coordinator = {
        onEnvelope: () => ({ event: '', done: Promise.resolve() }),
        evidenceFor: (message) => { verified.set(message.invocationToken, message); return { ok: true, principal: 'user:alice', grant: `grant-of-${message.invocationToken}` }; },
        close() {},
    };
    const runtime = { workingDir, sessionStore, initialSession, engine, historyManager: new HistoryManager({ workingDir }),
        skillCatalog: { getSkills: () => [] }, settings: {}, backgroundTasks: null };
    const dispatcher = createWebchatDispatcher(runtime, { write: () => {}, coordinator });
    t.after(() => dispatcher.cancel());
    return { dispatcher, seen, verified, coordinator };
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
