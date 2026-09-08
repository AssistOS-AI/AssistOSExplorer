import assert from 'node:assert/strict';
import test from 'node:test';

import { callAgentTool } from '../src/lib/agentMcpClient.mjs';

test('generated-local Agent MCP has no credentialed raw-URL fallback', async (t) => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        throw new Error('unexpected fetch');
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    for (const signal of [
        'PLOINKY_ROUTER_DESCRIPTOR_FILE',
        'PLOINKY_ROUTER_URL',
        'PLOINKY_ROUTER_HOST',
        'PLOINKY_ROUTER_PORT',
        'PLOINKY_AGENT_API_KEY',
        'PLOINKY_ENV_SOURCE_PLOINKY_FUTURE_FIELD',
    ]) {
        let valueReads = 0;
        const values = { [signal]: signal.startsWith('PLOINKY_ENV_SOURCE_') ? 'generated' : 'present' };
        const env = new Proxy(values, {
            get(target, property, receiver) {
                valueReads += 1;
                return Reflect.get(target, property, receiver);
            },
        });
        await assert.rejects(
            callAgentTool('target', 'tool', {}, {
                env,
                invocationToken: 'credential',
            }),
            (error) => error?.code === 'PLOINKY_AGENT_MCP_LOCAL_TRANSPORT_NOT_CERTIFIED',
        );
        assert.equal(valueReads, 0, `${signal} must reject by name before any env value read`);
        assert.equal(fetchCalls, 0, `${signal} must reject before transport`);
    }
});

test('ordinary Ploinky identity does not claim generated-local Agent MCP authority', async (t) => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ result: { content: [] } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    const env = {
        PLOINKY_AGENT_ID: 'agent:repo/caller',
        PLOINKY_AGENT_PRINCIPAL: 'agent:repo/caller',
        PLOINKY_AGENT_INSTANCE_ID: 'ordinary-instance',
        PLOINKY_AGENT_ENABLE_GENERATION: 'ordinary-generation',
    };
    await callAgentTool('target', 'tool', {}, { env });
    assert.equal(fetchCalls, 1);
});
