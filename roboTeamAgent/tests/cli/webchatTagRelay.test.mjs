import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
    createWebchatTagRelay,
    normalizeWebchatMessage,
    parseTagRelayMention
} from '../achilles-cli/src/lib/webchatTagRelay.mjs';

function startStubRouter(handler) {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            let body = {};
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            } catch {
                body = {};
            }
            const call = {
                method: req.method,
                url: req.url,
                jwt: req.headers['x-ploinky-caller-jwt'] || '',
                body,
            };
            calls.push(call);
            const response = handler(call);
            res.writeHead(response.status || 200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(response.body || {}));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: server.address().port, calls });
        });
    });
}

describe('webchat tag relay', () => {
    it('normalizes webchat envelopes without exposing raw JSON to prompts', () => {
        const message = normalizeWebchatMessage(JSON.stringify({
            __webchatMessage: 1,
            version: 1,
            text: '@open-interpreter summarize',
            attachments: [{ filename: 'notes.md', mime: 'text/markdown', localPath: 'shared/blob-1' }],
            invocation: { token: 'caller-token' },
        }));
        assert.equal(message.rawText, '@open-interpreter summarize');
        assert.match(message.text, /Attachments:/);
        assert.equal(message.attachments.length, 1);
        assert.equal(message.invocationToken, 'caller-token');
    });

    it('parses mention tags and leaves unknown-tag policy to the configured relay catalog', () => {
        assert.deepEqual(parseTagRelayMention('@open-interpreter summarize notes'), {
            tag: 'open-interpreter',
            prompt: 'summarize notes',
        });
        assert.deepEqual(parseTagRelayMention('please ask @oi now'), {
            tag: 'oi',
            prompt: 'please ask now',
        });
        assert.equal(parseTagRelayMention('plain chat'), null);
    });

    it('delegates known tags through configured MCP agent and tools', async () => {
        const { server, port, calls } = await startStubRouter((call) => {
            const tool = call.body?.params?.name;
            if (tool === 'research_relay_list_backends') {
                return {
                    body: {
                        jsonrpc: '2.0',
                        id: call.body.id,
                        result: {
                            content: [{
                                type: 'text',
                                text: JSON.stringify({ backends: [{ id: 'open-interpreter', tags: ['open-interpreter', 'oi'] }] }),
                            }],
                        },
                    },
                };
            }
            return {
                body: {
                    jsonrpc: '2.0',
                    id: call.body.id,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({ final_answer: 'Open Interpreter needs model configuration.' }),
                        }],
                    },
                },
            };
        });
        try {
            const relay = createWebchatTagRelay({
                enabled: true,
                agent: 'researchRelay',
                submitTool: 'research_task_submit',
                listTool: 'research_relay_list_backends',
                kind: 'research',
            });
            const result = await relay.handle({
                rawText: '@open-interpreter Give status.',
                text: '@open-interpreter Give status.',
                attachments: [],
                invocationToken: 'caller-token',
            }, {
                agentName: 'achilles-cli',
                workingDir: '/workspace/project',
                env: { PLOINKY_ROUTER_URL: `http://127.0.0.1:${port}` },
            });
            assert.equal(result.handled, true);
            assert.equal(result.output, 'Open Interpreter needs model configuration.');
            assert.equal(calls.length, 2);
            assert.equal(calls[0].jwt, 'caller-token');
            assert.equal(calls[1].jwt, 'caller-token');
            assert.match(calls[0].url, /researchRelay/);
            assert.equal(calls[1].body.params.name, 'research_task_submit');
            assert.equal(calls[1].body.params.arguments.backend, 'open-interpreter');
            assert.equal(calls[1].body.params.arguments.prompt, 'Give status.');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('uses explicit configured tags without a catalog preflight', async () => {
        const { server, port, calls } = await startStubRouter((call) => ({
            body: {
                jsonrpc: '2.0',
                id: call.body.id,
                result: {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ final_answer: 'Submitted through explicit tags.' }),
                    }],
                },
            },
        }));
        try {
            const relay = createWebchatTagRelay({
                enabled: true,
                agent: 'researchRelay',
                submitTool: 'research_task_submit',
                listTool: 'research_relay_list_backends',
                tags: 'open-interpreter,oi',
            });
            const result = await relay.handle({
                rawText: '@oi Give status.',
                text: '@oi Give status.',
                attachments: [],
                invocationToken: 'caller-token',
            }, {
                env: { PLOINKY_ROUTER_URL: `http://127.0.0.1:${port}` },
            });
            assert.equal(result.handled, true);
            assert.equal(result.output, 'Submitted through explicit tags.');
            assert.equal(calls.length, 1);
            assert.equal(calls[0].body.params.name, 'research_task_submit');
            assert.equal(calls[0].body.params.arguments.backend, 'oi');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('lets unknown mention tags fall through as ordinary chat', async () => {
        const { server, port } = await startStubRouter((call) => ({
            body: {
                jsonrpc: '2.0',
                id: call.body.id,
                result: {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ backends: [{ id: 'open-interpreter', tags: ['open-interpreter'] }] }),
                    }],
                },
            },
        }));
        try {
            const relay = createWebchatTagRelay({
                enabled: true,
                agent: 'researchRelay',
                submitTool: 'research_task_submit',
                listTool: 'research_relay_list_backends',
            });
            const result = await relay.handle({
                rawText: '@teammate please review this',
                text: '@teammate please review this',
                attachments: [],
                invocationToken: 'caller-token',
            }, {
                env: { PLOINKY_ROUTER_URL: `http://127.0.0.1:${port}` },
            });
            assert.equal(result, null);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
