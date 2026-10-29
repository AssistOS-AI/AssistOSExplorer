import test from 'node:test';
import './helpers/isolated-ala-home.mjs';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebchatDispatcher } from '../src/lib/webchat/webchatRuntime.mjs';
import { normalizeWebchatMessage, webchatSignedArgs } from '../src/lib/webchat/webchatEnvelope.mjs';

// WebChat owner claims: sent on envelope arrival with the raw signed values,
// before the turn is queued or prepared, and dropped when no run used them.
// The session store and engine are stubs, so this runs on every platform.
const SESSION = { sessionId: '00000000-0000-4000-8000-0000000000aa', messages: [], createdAt: 't', updatedAt: 't' };

async function dispatcherFor(t, { executeTurn } = {}) {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'achilles-live-claim-'));
    t.after(() => fs.rm(workingDir, { recursive: true, force: true }));
    const events = [];
    // Attachment and reference materialization resolves paths; record it.
    const realpath = fsSync.realpathSync;
    fsSync.realpathSync = function (...args) { events.push(['materialize']); return realpath.apply(this, args); };
    t.after(() => { fsSync.realpathSync = realpath; });
    await fs.writeFile(path.join(workingDir, 'notes.md'), 'notes');
    const publisher = {
        claimOwner(token, args) { events.push(['claim', token, structuredClone(args)]); return Object.freeze({ claimId: `c_${events.length}` }); },
        releaseOwner(reference) { events.push(['release', reference?.claimId ?? null]); },
    };
    const runtime = { workingDir, livePublisher: publisher,
        sessionStore: { ensureCurrentSession: async () => { events.push(['session']); return SESSION; }, loadSession: () => SESSION },
        engine: { getModel: async () => ({ backend: 'codex', model: null }),
            executeTurn: async (request) => { events.push(['turn', request.context.liveOwner?.claimId ?? null]); return executeTurn ? executeTurn(request) : { outputText: 'ok' }; } },
        historyManager: { add: async () => {} }, skillCatalog: { getSkills: () => [] }, settings: {} };
    const dispatcher = createWebchatDispatcher(runtime, { write: () => {} });
    t.after(() => dispatcher.cancel());
    return { dispatcher, events };
}

// An envelope as Ploinky's serializer forwards it: references omitted when
// empty, presentation normalized, the token inside `invocation`.
function envelope(fields = {}) {
    return JSON.stringify({ __webchatMessage: 1, version: 1, text: 'Build the release notes', attachments: [],
        presentation: { visible: true }, sourceTabId: 'tab_1', sourcePageInstanceId: 'page_1',
        origin: { publicBaseUrl: 'http://localhost:8080' }, invocation: { token: 'signed.router.token' }, ...fields });
}

test('signed arguments are rebuilt from the raw envelope, not from the normalized message', () => {
    const raw = { __webchatMessage: 1, text: 'x', sourceTabId: 'tab with spaces', sourcePageInstanceId: '',
        attachments: [{ id: 'a', filename: 'f.txt', mime: null, size: 3, downloadUrl: null, localPath: '/tmp/f.txt' }],
        references: [{ kind: 'workspace-path', path: 'docs/a.md', type: ' doc ', label: null }], presentation: { visible: false } };
    const normalized = normalizeWebchatMessage(JSON.stringify(raw));
    assert.equal(normalized.sourceTabId, '', 'the normalized tab id is filtered');
    assert.equal(normalized.references[0].type, 'doc', 'normalization trims');
    assert.deepEqual(normalized.signedArgs, { surface: 'webchat', tabId: 'tab with spaces', pageInstanceId: '', text: 'x',
        attachments: raw.attachments, references: raw.references, presentation: { visible: false }, runtimeScope: 'principal' });
    assert.deepEqual(webchatSignedArgs({ __webchatMessage: 1 }), { surface: 'webchat', tabId: '', pageInstanceId: '', text: '',
        attachments: [], references: [], presentation: { visible: true }, runtimeScope: 'principal' });
});

test('the claim is sent on arrival, before materialization and preparation, and the turn carries it', async (t) => {
    const { dispatcher, events } = await dispatcherFor(t);
    const references = [{ kind: 'workspace-path', path: 'notes.md', type: 'file', label: null }];
    dispatcher.receive(envelope({ references }));
    // The claim is the first thing receive() does: before the referenced path
    // is materialized, before the session lookup and long before the turn.
    assert.deepEqual(events[0], ['claim', 'signed.router.token', { surface: 'webchat', tabId: 'tab_1', pageInstanceId: 'page_1',
        text: 'Build the release notes', attachments: [], references, presentation: { visible: true }, runtimeScope: 'principal' }]);
    assert.ok(events.some(([kind]) => kind === 'materialize'), 'the reference was materialized after the claim');
    assert.equal(events.some(([kind]) => kind === 'turn'), false);
    await dispatcher.drain();
    assert.deepEqual(events.filter(([kind]) => kind !== 'materialize').slice(1), [['session'], ['turn', 'c_1'], ['release', 'c_1']]);
});

test('a turn that fails before publishing, such as a same-session overlap, releases its claim', async (t) => {
    const { dispatcher, events } = await dispatcherFor(t, { executeTurn: async () => {
        throw Object.assign(new Error('Conversation is busy: another turn holds its lease.'), { code: 'LEASE_HELD' });
    } });
    dispatcher.receive(envelope());
    await dispatcher.drain();
    assert.deepEqual(events.filter(([kind]) => kind === 'release'), [['release', 'c_1']]);
});

test('messages without a Router token, and plain text, make no claim', async (t) => {
    const { dispatcher, events } = await dispatcherFor(t);
    dispatcher.receive(envelope({ invocation: undefined }));
    dispatcher.receive('plain prompt');
    await dispatcher.drain();
    assert.equal(events.some(([kind]) => kind === 'claim'), false);
    assert.deepEqual(events.filter(([kind]) => kind === 'turn'), [['turn', null], ['turn', null]]);
});
