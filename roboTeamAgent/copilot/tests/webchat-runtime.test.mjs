import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationSessionStore } from '../src/lib/conversationSessionStore.mjs';
import { HistoryManager } from '../src/repl/HistoryManager.mjs';
import { createWebchatDispatcher } from '../src/lib/webchatRuntime.mjs';

function eventQueue() {
    const events = [];
    const waiting = [];
    return {
        events,
        write(value) {
            const event = JSON.parse(value);
            events.push(event);
            for (let index = waiting.length - 1; index >= 0; index -= 1) {
                if (waiting[index].matches(event)) waiting.splice(index, 1)[0].resolve(event);
            }
        },
        next(matches) {
            return new Promise((resolve) => waiting.push({ matches, resolve }));
        },
    };
}

test('tabs run different sessions concurrently, retain selection on reload, and Stop targets only its turn', { timeout: 10000 }, async (t) => {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'achilles-webchat-tabs-'));
    t.after(() => fs.rm(workingDir, { recursive: true, force: true }));
    const sessionStore = new ConversationSessionStore({ workingDir });
    const initialSession = await sessionStore.ensureCurrentSession();
    const completions = new Map();
    const engine = {
        async executeTurn({ sessionId, turnId, prompt, signal, onEvent }) {
            const turn = await sessionStore.beginTurn({ sessionId, turnId, text: prompt });
            const settled = new Promise((resolve, reject) => {
                completions.set(prompt, resolve);
                signal.addEventListener('abort', () => reject(Object.assign(new Error('interrupted'), { name: 'AbortError' })), { once: true });
            });
            await onEvent({ type: 'turn-started', ...turn, turnId });
            try {
                await settled;
                const outputText = `${prompt.toUpperCase()} completed`;
                const session = await sessionStore.completeTurn(sessionId, turn.assistantMessageId, outputText);
                return { outputText, session };
            } catch (error) {
                await sessionStore.completeTurn(sessionId, turn.assistantMessageId, error.message, { status: 'interrupted' });
                throw error;
            }
        },
    };
    const output = eventQueue();
    const runtime = { workingDir, sessionStore, initialSession, engine, historyManager: new HistoryManager({ workingDir }),
        skillCatalog: { getSkills: () => [] }, settings: {}, backgroundTasks: null };
    const dispatcher = createWebchatDispatcher(runtime, { write: (value) => output.write(value) });
    t.after(() => dispatcher.cancel());
    const send = (tab, text, page = 'page1') => dispatcher.receive(JSON.stringify({ __webchatMessage: 1, version: 1,
        text, sourceTabId: tab, sourcePageInstanceId: page, presentation: { visible: false } }));
    const selectedA = output.next((event) => event.event === 'selected' && event.targetTabId === 'tabA');
    send('tabA', '/session new');
    const sessionA = (await selectedA).session.sessionId;
    const startedA = output.next((event) => event.event === 'updated' && event.targetTabId === 'tabA');
    send('tabA', 'alpha');
    await startedA;

    const selectedB = output.next((event) => event.event === 'selected' && event.targetTabId === 'tabB');
    send('tabB', '/session new');
    const sessionB = (await selectedB).session.sessionId;
    assert.notEqual(sessionB, sessionA);
    const startedB = output.next((event) => event.event === 'updated' && event.targetTabId === 'tabB');
    send('tabB', 'beta');
    await startedB;

    const reloaded = output.next((event) => event.event === 'list' && event.targetTabId === 'tabA');
    send('tabA', '/session', 'page2');
    assert.equal((await reloaded).currentSessionId, sessionA);
    dispatcher.receive(JSON.stringify({ __webchatControl: 1, type: 'stop', sourceTabId: 'tabB', sourcePageInstanceId: 'page1' }));
    completions.get('alpha')();
    await dispatcher.drain();
    const a = sessionStore.loadSession(sessionA);
    const b = sessionStore.loadSession(sessionB);
    assert.deepEqual(a.messages.map((message) => message.text), ['alpha', 'ALPHA completed']);
    assert.deepEqual(b.messages.map((message) => message.text), ['beta', 'interrupted']);
    assert.equal(a.messages[1].status, 'completed');
    assert.equal(b.messages[1].status, 'interrupted');
    assert.ok(output.events.filter((event) => event.event === 'updated' && event.session?.sessionId === sessionA)
        .every((event) => event.targetTabId === 'tabA'));
});
