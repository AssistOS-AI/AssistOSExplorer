import test from 'node:test';
import assert from 'node:assert/strict';
import { getEmailAuthCodeStatus, sendAuthCode } from '../lib/email-agent-client.mjs';

test('email readiness uses the internal status tool and returns only a strict availability bit', async () => {
    for (const [response, available] of [
        [{ available: true, secret: 'must-not-return' }, true],
        [{ content: [{ type: 'text', text: '{"available":true}' }] }, true],
        [{ available: false }, false],
        [{ available: 'true' }, false],
        [{ isError: true, content: [{ type: 'text', text: '{"available":true}' }] }, false],
        [{ error: 'denied', available: true }, false],
        [{ content: [{ type: 'text', text: 'not JSON' }] }, false],
        [{}, false],
    ]) {
        const calls = [];
        let closed = false;
        const status = await getEmailAuthCodeStatus({ createClient: async () => ({
            callTool: async (...args) => { calls.push(args); return response; },
            close: () => { closed = true; },
        }) });
        assert.deepEqual(status, { available });
        assert.deepEqual(calls, [['email_auth_code_status', {}]], 'Readiness must never send a test code or query private settings.');
        assert.equal(closed, true);
    }
});

test('email readiness fails closed for missing clients, failed tools and bounded timeouts, including slow acquisition and close', async () => {
    assert.deepEqual(await getEmailAuthCodeStatus({ createClient: async () => { throw new Error('missing provider'); } }), { available: false });
    assert.deepEqual(await getEmailAuthCodeStatus({ createClient: async () => ({ callTool: async () => { throw new Error('denied'); } }) }), { available: false });
    let releasedClient;
    let closed = false;
    const pendingClient = new Promise((resolve) => { releasedClient = resolve; });
    const started = Date.now();
    assert.deepEqual(await getEmailAuthCodeStatus({ createClient: () => pendingClient, timeoutMs: 20 }), { available: false });
    assert.ok(Date.now() - started < 1000);
    releasedClient({ callTool: () => assert.fail('a client acquired after expiry must not call the tool'), close: () => { closed = true; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, true);

    closed = false;
    const unavailable = await getEmailAuthCodeStatus({ timeoutMs: 20, createClient: async () => ({
        callTool: () => new Promise(() => {}),
        close: () => { closed = true; return new Promise(() => {}); },
    }) });
    assert.deepEqual(unavailable, { available: false });
    assert.equal(closed, true, 'the deadline initiates client shutdown without waiting forever for it');
});

test('email delivery never mistakes an MCP error or malformed response for provider acceptance', async () => {
    for (const response of [
        { isError: true, content: [{ type: 'text', text: 'MCP error: unavailable' }] },
        { content: [{ type: 'text', text: 'malformed' }] },
        {}, { providerMessageId: '' }, { providerMessageId: 123 },
        { ok: false, providerMessageId: 'not-a-success' },
    ]) {
        const result = await sendAuthCode({ to: 'member@example.test', code: '123456' }, { createClient: async () => ({ callTool: async () => response }) });
        assert.equal(result.delivered, false);
    }
    const calls = [];
    const accepted = await sendAuthCode({ to: 'member@example.test', code: '123456', correlationId: 'request' }, { createClient: async () => ({
        callTool: async (...args) => { calls.push(args); return { content: [{ type: 'text', text: '{"providerMessageId":"provider-1"}' }] }; },
    }) });
    assert.equal(accepted.delivered, true);
    assert.equal(accepted.providerMessageId, 'provider-1');
    assert.deepEqual(calls, [['email_send_auth_code', { to: 'member@example.test', code: '123456', correlationId: 'request' }]]);
});
