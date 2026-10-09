import test from 'node:test';
import assert from 'node:assert/strict';

// Widget session-credential handling (AM6 DR1/DR2). The widget module is
// browser code; its window bootstrap is guarded, so Node can import it.
const WIDGET = '../IDE-plugins/web-assist-chat/web-assist-chat.js';
const SECRET = 'S3cr3t-Value_abcdefghijklmnopqrstuvwxyz0123';

function fakeClient(responses) {
    const calls = [];
    return {
        calls,
        async callTool(name, args) {
            calls.push({ name, args });
            const next = responses.shift();
            return typeof next === 'function' ? next(name, args) : next;
        },
    };
}

async function chatClientWith(responses) {
    const { WebAssistMcpChatClient } = await import(WIDGET);
    const client = new WebAssistMcpChatClient({ validateTools: false });
    client.mcpClient = fakeClient(responses);
    return client;
}

function stdout(payload, stderr = '') {
    const content = [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }];
    if (stderr) content.push({ type: 'text', text: `stderr:\n${stderr}` });
    return { content };
}

test('chat parses only the stdout block and returns the session credentials', async () => {
    const client = await chatClientWith([stdout({ siteId: 's', sessionId: 'session-1', sessionSecret: SECRET, message: 'Hello!' }, `warning ${SECRET}`)]);
    const result = await client.invokeChat('s', 'hi');
    assert.equal(result.responseText, 'Hello!');
    assert.equal(result.sessionId, 'session-1');
    assert.equal(result.sessionSecret, SECRET);
});

test('chat never renders raw tool text', async () => {
    const unreadable = await chatClientWith([stdout(`not json but carries ${SECRET}`)]);
    await assert.rejects(unreadable.invokeChat('s', 'hi'), (error) => !String(error.message).includes(SECRET));

    const noMessage = await chatClientWith([stdout({ siteId: 's', sessionId: 'session-1', sessionSecret: SECRET })]);
    const result = await noMessage.invokeChat('s', 'hi');
    assert.equal(result.responseText.includes(SECRET), false);
    assert.equal(result.responseText, '(no output)');

    const failed = await chatClientWith([{ isError: true, content: [{ type: 'text', text: `boom ${SECRET}` }] }]);
    await assert.rejects(failed.invokeChat('s', 'hi'), (error) => !String(error.message).includes(SECRET));
});

test('chat and history send the stored session secret', async () => {
    const client = await chatClientWith([
        stdout({ siteId: 's', sessionId: 'session-1', message: 'ok' }),
        stdout({ siteId: 's', sessionId: 'session-1', exists: true, history: [] }),
    ]);
    await client.invokeChat('s', 'hi', 'session-1', SECRET);
    await client.invokeHistory('s', 'session-1', SECRET);
    assert.deepEqual(client.mcpClient.calls.map((call) => call.args.sessionSecret), [SECRET, SECRET]);

    const bare = await chatClientWith([stdout({ siteId: 's', sessionId: 'session-2', message: 'ok' })]);
    await bare.invokeChat('s', 'hi', '', '');
    assert.equal(Object.hasOwn(bare.mcpClient.calls[0].args, 'sessionSecret'), false);
    assert.equal(Object.hasOwn(bare.mcpClient.calls[0].args, 'sessionId'), false);
});

test('session credential updates keep, replace together, or clear', async () => {
    const { nextChatSessionState } = await import(WIDGET);
    const current = { sessionId: 'session-1', sessionSecret: SECRET };
    assert.deepEqual(nextChatSessionState(current, { sessionId: 'session-1' }), current, 'principal match keeps the secret');
    assert.deepEqual(nextChatSessionState(current, { sessionId: '' }), current, 'no session in the response keeps both');
    assert.deepEqual(
        nextChatSessionState(current, { sessionId: 'session-2', sessionSecret: 'N'.repeat(43) }),
        { sessionId: 'session-2', sessionSecret: 'N'.repeat(43) },
        'rotation replaces both together'
    );
    assert.deepEqual(nextChatSessionState(current, { sessionId: 'session-3' }), { sessionId: 'session-3', sessionSecret: '' }, 'a new session without a secret clears it');
    assert.deepEqual(nextChatSessionState({ sessionId: '', sessionSecret: '' }, { sessionId: 'session-4', sessionSecret: SECRET }), { sessionId: 'session-4', sessionSecret: SECRET });
});

// achillesAgentLib prints this banner to stdout before the tool's JSON when
// ACHILLES_DEBUG is 1 or true; AgentServer returns stdout as content[0].
const DEBUG_BANNER = [
    '[AchillesAgentsLib] Default LLM configuration:',
    '[AchillesAgentsLib]   Config file: /code/node_modules/achillesAgentLib/LLMConfig.json',
    '[AchillesAgentsLib]   Supported tiers: unknown',
].join('\n');

test('chat and history tolerate the AchillesAgentLib debug banner before the JSON', async () => {
    const chatJson = JSON.stringify({ siteId: 's', sessionId: 'session-1', message: 'Hello!', sessionSecret: SECRET }, null, 2);
    const historyJson = JSON.stringify({ siteId: 's', sessionId: 'session-1', exists: true, sessionKuId: 'ku_sess_session-1', history: [{ role: 'user', message: 'hi' }] }, null, 2);
    const client = await chatClientWith([
        stdout(`${DEBUG_BANNER}\n${chatJson}\n`, `stderr text ${SECRET}`),
        stdout(`${DEBUG_BANNER}\n${historyJson}\n`),
    ]);
    const chat = await client.invokeChat('s', 'hi');
    assert.equal(chat.responseText, 'Hello!');
    assert.equal(chat.sessionId, 'session-1');
    assert.equal(chat.sessionSecret, SECRET);
    const history = await client.invokeHistory('s', 'session-1', SECRET);
    assert.deepEqual(history.history, [{ role: 'user', message: 'hi' }]);
});

test('a preamble never turns raw or partial tool text into a result', async () => {
    const withoutObject = await chatClientWith([stdout(`${DEBUG_BANNER}\nnot json ${SECRET}`)]);
    await assert.rejects(withoutObject.invokeChat('s', 'hi'), (error) => !String(error.message).includes(SECRET));
    const wrongShape = await chatClientWith([stdout(`${DEBUG_BANNER}\n{"unexpected": "${SECRET}"}`)]);
    await assert.rejects(wrongShape.invokeChat('s', 'hi'), (error) => !String(error.message).includes(SECRET));
    const stderrOnly = await chatClientWith([{ content: [{ type: 'text', text: DEBUG_BANNER }, { type: 'text', text: `stderr:\n{"siteId":"s","sessionId":"x","message":"${SECRET}"}` }] }]);
    await assert.rejects(stderrOnly.invokeChat('s', 'hi'), (error) => !String(error.message).includes(SECRET));
});
