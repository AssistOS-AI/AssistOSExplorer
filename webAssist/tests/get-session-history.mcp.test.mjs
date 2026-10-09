import test from 'node:test';
import assert from 'node:assert/strict';

import { appendSessionTurn, updateSessionProfile } from '../src/runtime/update-session.mjs';
import { getSessionHistory } from '../src/mcp/get-session-history.mjs';
import { callerAccessFromEnvelope, createSessionOwner, generateSessionSecret, hashSessionSecret } from '../src/runtime/sessionAccess.mjs';
import { createWebAssistSandbox, ensureSiteAku } from './helpers.mjs';
import { PRINCIPALS, guestGrant, toolEnvelope, userGrant } from './fixtures/verified-grant.mjs';

const SITE_ID = 'demo-site';

async function accessFor(grant) {
    return callerAccessFromEnvelope(toolEnvelope(grant, {}, 'web_cli_history'));
}

test('web_cli_history returns parsed session history for existing sessions', async (t) => {
    const sandbox = await createWebAssistSandbox();
    t.after(async () => sandbox.cleanup());
    await ensureSiteAku({
        siteId: SITE_ID,
    });
    const owner = await accessFor(await guestGrant());
    assert.equal(await createSessionOwner({
        siteId: SITE_ID,
        sessionId: 'history-sess-1',
        access: owner,
        secretHash: hashSessionSecret(generateSessionSecret()),
    }), true);

    await updateSessionProfile({
        siteId: SITE_ID,
        sessionId: 'history-sess-1',
        profileDetails: ['Interested in API integration'],
    });
    await appendSessionTurn({
        siteId: SITE_ID,
        sessionId: 'history-sess-1',
        userMessage: 'Hello there',
        agentResponse: 'Hi! How can I help today?',
    });
    await updateSessionProfile({
        siteId: SITE_ID,
        sessionId: 'history-sess-1',
        profileDetails: ['Asks about pricing'],
    });
    await appendSessionTurn({
        siteId: SITE_ID,
        sessionId: 'history-sess-1',
        userMessage: 'I need pricing details',
        agentResponse: 'Sure. Which team size are you targeting?',
    });

    const result = await getSessionHistory({
        siteId: SITE_ID,
        sessionId: 'history-sess-1',
        access: owner,
    });
    const adminResult = await getSessionHistory({
        siteId: SITE_ID,
        sessionId: 'history-sess-1',
        access: await accessFor(await userGrant(PRINCIPALS.admin)),
    });
    assert.deepEqual(adminResult, result);

    assert.equal(result.siteId, SITE_ID);
    assert.equal(result.sessionId, 'history-sess-1');
    assert.equal(result.exists, true);
    assert.equal(result.sessionKuId, 'ku_sess_history-sess-1');
    assert.equal(result.history.length, 4);
    assert.deepEqual(result.history[0], { role: 'user', message: 'Hello there' });
    assert.deepEqual(result.history[1], { role: 'agent', message: 'Hi! How can I help today?' });
    assert.deepEqual(result.history[2], { role: 'user', message: 'I need pricing details' });
    assert.deepEqual(result.history[3], { role: 'agent', message: 'Sure. Which team size are you targeting?' });
});

test('web_cli_history returns empty history when session file is missing', async (t) => {
    const sandbox = await createWebAssistSandbox();
    t.after(async () => sandbox.cleanup());

    const result = await getSessionHistory({
        siteId: SITE_ID,
        sessionId: 'missing-session',
        access: await accessFor(await guestGrant()),
    });

    assert.equal(result.siteId, SITE_ID);
    assert.equal(result.sessionId, 'missing-session');
    assert.equal(result.exists, false);
    assert.deepEqual(result.history, []);
    assert.equal(result.sessionKuId, 'ku_sess_missing-session');
});
