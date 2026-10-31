import test from 'node:test';
import './helpers/isolated-ala-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationSessionStore } from '../src/lib/storage/conversationSessionStore.mjs';
import { HistoryManager } from '../src/repl/HistoryManager.mjs';
import { createWebchatDispatcher } from '../src/lib/webchat/webchatRuntime.mjs';
import { ANSWER_TOO_LONG_NOTICE, UNVERIFIED_ANSWER_NOTICE, createWebchatInteractionController } from '../src/lib/webchat/webchatInteractionController.mjs';
import { createNativeInteractions } from '../src/lib/execution/nativeInteractions.mjs';
import { WEBCHAT_INTERACTION_RESPONSE_EVENT, normalizeWebchatMessage, webchatSignedArgs } from '../src/lib/webchat/webchatEnvelope.mjs';

// T2 approval relay, WebChat side (decision M-52 Q1/add. 1, deltas M6 and Finding 3, monitor note on oversize answers): only a
// Router-signed, verified interaction response answers a worker approval, with its verified owner; an unsigned or unverified one is never
// an answer and never a turn, and the question is asked again under a new interaction id.

function controller() {
    const lines = [];
    const stdout = { write: (text) => { for (const line of text.split('\n').filter(Boolean)) lines.push(JSON.parse(line)); } };
    return { lines, controller: createWebchatInteractionController({ stdout, timeoutMs: 60000 }) };
}
const shown = (lines) => lines.filter((line) => line.__webchatInteraction === 1);
const OWNER = { evidence: { ok: true, principal: 'user:alice', grant: 'grant-of-response' } };
const MARKUP = '<img src=x onerror="alert(1)"> **bold** [x](javascript:alert(2))';

test('requireSigned select: an unsigned response is never an answer: the card closes and the question is asked again under a new id, with a plain notice', async () => {
    const { lines, controller: c } = controller();
    let settled = null;
    const pending = c.select({ title: MARKUP, message: 'Allow writing a.txt?', options: [{ value: 'once', label: 'Allow once' }, { value: 'reject', label: 'Reject' }],
        targetTabId: 'tabA' }, { requireSigned: true }).then((value) => { settled = value; });
    const first = shown(lines)[0];
    assert.equal(first.title, MARKUP, 'robot text is passed on as plain text, unchanged');
    assert.equal(c.resolve({ id: first.id, optionId: 'choice_0' }, { sourceTabId: 'tabA' }), false);
    assert.equal(c.resolve({ id: shown(lines)[1].id, optionId: 'choice_0' }, { sourceTabId: 'tabA', verified: true }), false, 'verified without an owner is not enough');
    await Promise.resolve();
    assert.equal(settled, null);
    const asked = shown(lines);
    assert.equal(asked.length, 3);
    assert.notEqual(asked[1].id, first.id);
    assert.notEqual(asked[2].id, asked[1].id);
    assert.ok(asked[1].message.startsWith(UNVERIFIED_ANSWER_NOTICE));
    assert.ok(lines.some((line) => line.__webchatInteractionResolved === 1 && line.id === first.id && line.status === 'cancelled'), 'the unverified card is closed');
    assert.equal(c.resolve({ id: first.id, optionId: 'choice_0' }, { sourceTabId: 'tabA', verified: true, owner: OWNER }), false, 'the old id is gone');
    assert.equal(c.resolve({ id: asked[2].id, optionId: 'choice_1' }, { sourceTabId: 'tabA', verified: true, owner: OWNER }), true);
    await pending;
    assert.deepEqual(settled, { value: 'reject', owner: OWNER });
});

test('requireSigned: the owner\'s signed cancel settles with the owner; a reask of an unverified envelope works for any interaction', async () => {
    const { lines, controller: c } = controller();
    const cancelled = c.select({ title: 't', options: [{ value: 'a', label: 'A' }] }, { requireSigned: true });
    const card = shown(lines)[0];
    assert.equal(c.resolve({ id: card.id, cancelled: true }, { verified: true, owner: OWNER }), true);
    assert.deepEqual(await cancelled, { cancelled: true, owner: OWNER });
    const plain = c.select({ title: 'plain', options: [{ value: 'a', label: 'A' }] });
    const plainCard = shown(lines).at(-1);
    assert.equal(c.reaskUnverified(plainCard.id, {}), true);
    const again = shown(lines).at(-1);
    assert.notEqual(again.id, plainCard.id);
    assert.equal(c.resolve({ id: again.id, optionId: 'choice_0' }, {}), true, 'an interaction that does not need a signature still takes an unsigned answer');
    assert.equal(await plain, 'a');
});

test('free text longer than 32,000 characters is not used: the user is told and asked again (never a silent drop)', async () => {
    const { lines, controller: c } = controller();
    const answer = c.input({ title: 'Why?', maxLength: 65536 });
    const card = shown(lines)[0];
    assert.equal(c.resolve({ id: card.id, response: 'x'.repeat(32001) }, {}), false);
    const again = shown(lines).at(-1);
    assert.notEqual(again.id, card.id);
    assert.ok(again.message.startsWith(ANSWER_TOO_LONG_NOTICE));
    assert.equal(c.resolve({ id: again.id, response: 'y'.repeat(32000) }, {}), true);
    assert.equal((await answer).length, 32000);
});

test('nativeInteractions with requireSigned resolves {optionId, owner}; nothing answered is null; a terminal answers nothing', async () => {
    const { lines, controller: c } = controller();
    const interactions = createNativeInteractions({ webchatController: c });
    const event = { type: 'coding-agent-request', id: '00000000-0000-4000-8000-0000000000b1', kind: 'permission', title: 'T', message: 'M', options: [{ id: 'once', label: 'Once' }, { id: 'reject', label: 'Reject' }] };
    const answered = interactions.request(event, { requireSigned: true });
    await Promise.resolve();
    const card = shown(lines)[0];
    c.resolve({ id: card.id, optionId: 'choice_1' }, { verified: true, owner: OWNER });
    assert.deepEqual(await answered, { optionId: 'reject', owner: OWNER });
    const resolvedElsewhere = interactions.request({ ...event, id: '00000000-0000-4000-8000-0000000000b2' }, { requireSigned: true });
    await Promise.resolve();
    interactions.resolve('00000000-0000-4000-8000-0000000000b2', 'cancelled');
    assert.equal(await resolvedElsewhere, null);
    const terminal = createNativeInteractions({ selector: async () => 'once' });
    assert.equal(await terminal.request(event, { requireSigned: true }), null, 'CLI approvals stay refused (D1)');
});

// ---- the dispatcher's receive path ----
async function dispatcherFixture(t, { verify }) {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-approval-'));
    t.after(() => fs.rm(workingDir, { recursive: true, force: true }));
    const sessionStore = new ConversationSessionStore({ workingDir });
    const initialSession = await sessionStore.ensureCurrentSession();
    const turns = [];
    const engine = { async executeTurn(args) { turns.push(args); return { outputText: 'x' }; } };
    const coordinator = {
        onEnvelope: (message) => (verify(message) ? { event: message.event, done: Promise.resolve() } : { event: '', done: Promise.resolve() }),
        evidenceFor: (message) => (verify(message) ? { ok: true, principal: 'user:alice', grant: `grant-of-${message.invocationToken}`, event: message.event } : { ok: false, code: 'unverified' }),
        close() {},
    };
    const { lines, controller: webchatController } = controller();
    const runtime = { workingDir, sessionStore, initialSession, engine, webchatController, historyManager: new HistoryManager({ workingDir }),
        skillCatalog: { getSkills: () => [] }, settings: {}, backgroundTasks: null };
    const dispatcher = createWebchatDispatcher(runtime, { write: () => {}, coordinator });
    t.after(() => dispatcher.cancel());
    return { dispatcher, turns, lines, webchatController };
}
const responseEnvelope = (interaction, token = 'tok-r') => JSON.stringify({ __webchatMessage: 1, version: 1, text: '', attachments: [], presentation: { visible: false },
    sourceTabId: 'tabA', sourcePageInstanceId: 'page1', event: WEBCHAT_INTERACTION_RESPONSE_EVENT, interaction, invocation: { token } });

test('receive: a verified signed interaction-response answers with its verified owner and starts no turn', async (t) => {
    const f = await dispatcherFixture(t, { verify: () => true });
    const answer = f.webchatController.select({ title: 't', options: [{ value: 'once', label: 'Once' }], targetTabId: 'tabA' }, { requireSigned: true });
    const card = shown(f.lines)[0];
    f.dispatcher.receive(responseEnvelope({ id: card.id, optionId: 'choice_0' }, 'tok-answer'));
    const settled = await answer;
    assert.equal(settled.value, 'once');
    assert.deepEqual(settled.owner.evidence, { ok: true, principal: 'user:alice', grant: 'grant-of-tok-answer', event: WEBCHAT_INTERACTION_RESPONSE_EVENT });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.turns.length, 0);
});

test('receive: an unverified (unsigned or tampered) interaction-response, option or free text, answers nothing, starts no turn and asks again with a new id', async (t) => {
    const f = await dispatcherFixture(t, { verify: () => false });
    let settled = false;
    f.webchatController.select({ title: 't', options: [{ value: 'once', label: 'Once' }], targetTabId: 'tabA' }, { requireSigned: true }).then(() => { settled = true; });
    const card = shown(f.lines)[0];
    f.dispatcher.receive(responseEnvelope({ id: card.id, optionId: 'choice_0' }));
    const second = shown(f.lines).at(-1);
    assert.notEqual(second.id, card.id);
    f.dispatcher.receive(responseEnvelope({ id: second.id, response: 'a free-text answer that must not become a prompt' }));
    // The Router's unsigned legacy line is refused the same way for a worker approval.
    const third = shown(f.lines).at(-1);
    f.dispatcher.receive(JSON.stringify({ __webchatInteractionResponse: 1, version: 1, id: third.id, sourceTabId: 'tabA', optionId: 'choice_0', verified: true, owner: OWNER }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false);
    assert.equal(f.turns.length, 0, 'never a turn');
    assert.equal(shown(f.lines).length, 4, 'asked again each time');
});

test('the signed-args contract: the interaction is signed in canonical form and the message carries exactly that form', () => {
    const envelope = { sourceTabId: 'tabA', sourcePageInstanceId: 'p', text: '', event: WEBCHAT_INTERACTION_RESPONSE_EVENT, interaction: { id: 'task_control_x', optionId: 'choice_0', extra: 'dropped' } };
    const args = webchatSignedArgs(envelope);
    assert.deepEqual(args.interaction, { id: 'task_control_x', optionId: 'choice_0' });
    assert.equal(args.event, WEBCHAT_INTERACTION_RESPONSE_EVENT);
    const message = normalizeWebchatMessage(JSON.stringify({ __webchatMessage: 1, ...envelope }));
    assert.deepEqual(message.interaction, args.interaction);
    assert.deepEqual(webchatSignedArgs({ ...envelope, interaction: { id: 'i', cancelled: true } }).interaction, { id: 'i', cancelled: true });
    assert.deepEqual(webchatSignedArgs({ ...envelope, interaction: { id: 'i', response: 'text' } }).interaction, { id: 'i', response: 'text' });
    assert.equal(webchatSignedArgs({ ...envelope, interaction: undefined }).interaction, null);
    assert.equal(Object.hasOwn(webchatSignedArgs({ ...envelope, event: 'stop' }), 'interaction'), false, 'other events are unchanged');
});
