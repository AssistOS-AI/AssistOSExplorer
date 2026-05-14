import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
    createWebchatTagRelay,
    materializeWorkspaceReferences,
    normalizeWebchatMessage,
    normalizeWebchatReferences
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
            calls.push({
                method: req.method,
                url: req.url,
                jwt: req.headers['x-ploinky-caller-jwt'] || '',
                body,
            });
            const response = handler({ body });
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

function makeWorkingDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `achilles-references-${prefix}-`));
}

describe('webchat references', () => {
    it('normalizes envelope references and drops unsafe entries', () => {
        const message = normalizeWebchatMessage(JSON.stringify({
            __webchatMessage: 1,
            version: 1,
            text: 'inspect',
            attachments: [],
            references: [
                { kind: 'workspace-path', path: 'notes.md', type: 'file', label: 'Notes' },
                { kind: 'workspace-path', path: '../escape' },
                { kind: 'workspace-path', path: '/etc/passwd' },
                { kind: 'workspace-path', path: 'docs/.secrets' },
                { kind: 'workspace-path', path: 'with\0nul' },
                { kind: 'unknown-kind', path: 'notes.md' }
            ],
            invocation: { token: 'caller-token' }
        }));
        assert.equal(message.references.length, 1);
        assert.equal(message.references[0].path, 'notes.md');
        assert.match(message.text, /Referenced workspace paths:/);
    });

    it('normalizeWebchatReferences accepts only workspace-path entries with safe paths', () => {
        const cleaned = normalizeWebchatReferences([
            { kind: 'workspace-path', path: 'src/index.mjs', type: 'file' },
            { kind: 'workspace-path', path: 'src/index.mjs', type: 'file' },
            { kind: 'workspace-path', path: '' },
            { kind: '', path: 'ignored.md' }
        ]);
        assert.equal(cleaned.length, 1);
        assert.equal(cleaned[0].path, 'src/index.mjs');
    });

    it('materializeWorkspaceReferences emits resources for files and warnings for rejects', () => {
        const root = makeWorkingDir('materialize');
        try {
            fs.writeFileSync(path.join(root, 'notes.md'), 'hello world');
            fs.mkdirSync(path.join(root, 'logs'));
            const { resources, paths, warnings } = materializeWorkspaceReferences([
                { kind: 'workspace-path', path: 'notes.md', type: 'file', label: 'Notes' },
                { kind: 'workspace-path', path: 'logs', type: 'directory' },
                { kind: 'workspace-path', path: 'missing.txt', label: 'Missing' },
                { kind: 'workspace-path', path: '../outside.txt' }
            ], { workingDir: root });
            assert.equal(resources.length, 1);
            assert.equal(resources[0].content, 'hello world');
            assert.equal(resources[0].workspacePath, 'notes.md');
            assert.equal(paths.length, 1);
            assert.equal(paths[0].path, 'logs');
            assert.equal(paths[0].type, 'directory');
            assert.ok(warnings.some((entry) => entry.includes('Missing') && entry.includes('no longer available')));
            assert.ok(warnings.some((entry) => entry.includes('../outside.txt') && entry.includes('not a safe')));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('tag relay forwards materialized references through configured MCP tool', async () => {
        const root = makeWorkingDir('relay');
        const { server, port, calls } = await startStubRouter(({ body }) => ({
            body: {
                jsonrpc: '2.0',
                id: body.id,
                result: {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ final_answer: 'received references' }),
                    }]
                }
            }
        }));
        try {
            fs.writeFileSync(path.join(root, 'notes.md'), 'reference body');
            const relay = createWebchatTagRelay({
                enabled: true,
                agent: 'researchRelay',
                submitTool: 'research_task_submit',
                listTool: 'research_relay_list_backends',
                tags: 'open-interpreter',
            });
            const result = await relay.handle({
                rawText: '@open-interpreter inspect',
                text: '@open-interpreter inspect',
                attachments: [],
                references: [
                    { kind: 'workspace-path', path: 'notes.md', type: 'file', label: 'Notes' },
                    { kind: 'workspace-path', path: '../outside' }
                ],
                invocationToken: 'caller-token'
            }, {
                workingDir: root,
                env: { PLOINKY_ROUTER_URL: `http://127.0.0.1:${port}` }
            });
            assert.equal(result.handled, true);
            assert.equal(result.output, 'received references');
            assert.equal(calls.length, 1);
            const submitArguments = calls[0].body.params.arguments;
            assert.equal(submitArguments.backend, 'open-interpreter');
            assert.match(submitArguments.prompt, /inspect/);
            assert.match(submitArguments.prompt, /Reference forwarding notes:/);
            assert.equal(submitArguments.resources.length, 1);
            assert.equal(submitArguments.resources[0].workspacePath, 'notes.md');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
