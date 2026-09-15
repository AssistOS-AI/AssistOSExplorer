import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    resolveAgentExecutionMode,
    resolveAgentReadinessProtocol,
} from '../../../ploinky/cli/utils/runtime/startupReadiness.js';
import { computeRchTool } from '../../../ploinky/Agent/lib/requestHash.mjs';

const agentRoot = fileURLToPath(new URL('..', import.meta.url));
const ploinkyRoot = fileURLToPath(new URL('../../../ploinky', import.meta.url));
const agentLibRoot = process.env.PLOINKY_AGENTLIB_DIR || join(ploinkyRoot, 'node_modules/achillesAgentLib');
const { signHmacJwt } = await import(pathToFileURL(join(agentLibRoot, 'jwt/jwtSign.mjs')).href);

async function freePort() {
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const { port } = listener.address();
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    return port;
}

async function mcpRequest(port, body, sessionId, authorization) {
    const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
    };
    if (sessionId) {
        headers['mcp-session-id'] = sessionId;
        headers['mcp-protocol-version'] = '2025-06-18';
    }
    if (authorization) headers.authorization = authorization;
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return { headers: response.headers, body: JSON.parse(text) };
}

test('emailAgent starts its MCP server and executes verified email settings calls', { timeout: 15000 }, async (t) => {
    const manifest = JSON.parse(await readFile(join(agentRoot, 'manifest.json'), 'utf8'));
    const mode = resolveAgentExecutionMode(manifest);
    assert.equal(mode.type, 'implicit_agent_server', 'Email MCP tools require the default AgentServer process');
    assert.equal(resolveAgentReadinessProtocol(manifest), 'mcp');

    const stateDir = await mkdtemp(join(tmpdir(), 'emailagent-runtime-'));
    const config = JSON.parse(await readFile(join(agentRoot, 'mcp-config.json'), 'utf8'));
    for (const tool of config.tools) {
        // Substitute the container's /code mount for the same local tool source.
        tool.cwd = agentRoot;
        tool.command = process.execPath;
        tool.args = [join(agentRoot, 'tools/email_tool.mjs')];
    }
    const configPath = join(stateDir, 'mcp-config.json');
    await writeFile(configPath, JSON.stringify(config));
    const secret = randomBytes(32);
    const audience = 'agent:AssistOSExplorer/emailAgent';
    const port = await freePort();
    const child = spawn('/bin/sh', [join(ploinkyRoot, 'Agent/server/AgentServer.sh')], {
        cwd: stateDir,
        env: {
            PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}`,
            PORT: String(port),
            PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
            PLOINKY_AGENT_LIB_DIR: join(ploinkyRoot, 'Agent'),
            PLOINKY_AGENTLIB_DIR: agentLibRoot,
            PLOINKY_AGENT_CONFIG: configPath,
            PLOINKY_AGENT_MANIFEST: join(agentRoot, 'manifest.json'),
            PLOINKY_CODE_DIR: agentRoot,
            PLOINKY_AGENT_ID: audience,
            PLOINKY_AGENT_SECRET: secret.toString('hex'),
            PLOINKY_INVOCATION_AUTH_MODULE: pathToFileURL(join(ploinkyRoot, 'Agent/lib/invocation-auth.mjs')).href,
            EMAILAGENT_SETTINGS_KEY: 'email-runtime-test-settings-key',
            EMAILAGENT_SETTINGS_FILE: join(stateDir, 'data/settings.enc.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = once(child, 'exit');
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            await Promise.race([exited, delay(2000)]);
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
                await exited;
            }
        }
        await rm(stateDir, { recursive: true, force: true });
    });

    const deadline = Date.now() + 8000;
    let healthy = false;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
            await response.text();
            if (response.ok) {
                healthy = true;
                break;
            }
        } catch {
            // Wait for the supervisor's MCP process to bind its socket.
        }
        await delay(50);
    }
    assert.ok(healthy, `Email AgentServer did not become healthy:\n${output}`);

    const initialized = await mcpRequest(port, {
        jsonrpc: '2.0',
        id: 'initialize',
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'email-runtime-test', version: '1.0.0' },
        },
    });
    assert.ok(initialized.body.result?.capabilities?.tools, JSON.stringify(initialized.body));
    const sessionId = initialized.headers.get('mcp-session-id');
    assert.ok(sessionId, 'MCP initialization must establish a session');
    const listed = await mcpRequest(port, {
        jsonrpc: '2.0',
        id: 'tools',
        method: 'tools/list',
        params: {},
    }, sessionId);
    assert.deepEqual(listed.body.result?.tools?.map((tool) => tool.name).sort(), [
        'email_auth_code_status',
        'email_config_get',
        'email_config_set',
        'email_provider_status',
        'email_send_auth_code',
        'email_send_template',
        'email_send_test',
        'email_send_text',
    ]);

    async function callTool(name, args = {}, actor = { kind: 'user', id: 'user:email-admin', roles: ['admin'] }) {
        const now = Math.floor(Date.now() / 1000);
        const token = signHmacJwt({
            secret,
            payload: {
                typ: 'router-request',
                iss: 'ploinky-router',
                aud: audience,
                sub: actor.id,
                actor,
                method: 'POST',
                path: '/mcp',
                tool: name,
                rch: computeRchTool({ method: 'POST', path: '/mcp', tool: name, arguments: args }),
                jti: randomUUID(),
                iat: now,
                exp: now + 30,
            },
        });
        return (await mcpRequest(port, {
            jsonrpc: '2.0',
            id: randomUUID(),
            method: 'tools/call',
            params: { name, arguments: args },
        }, sessionId, `Bearer ${token}`)).body;
    }

    const status = await callTool('email_provider_status');
    assert.equal(status.error, undefined, JSON.stringify(status));
    assert.notEqual(status.result?.isError, true, JSON.stringify(status));
    assert.deepEqual(JSON.parse(status.result.content[0].text), { configured: false, fromEmail: '' });
    const agentActor = { kind: 'agent', id: 'agent:AssistOSExplorer/userPersistoAgent', roles: [] };
    const unavailable = await callTool('email_auth_code_status', {}, agentActor);
    assert.deepEqual(JSON.parse(unavailable.result.content[0].text), { available: false });
    const publicStatus = await callTool('email_auth_code_status');
    assert.equal(publicStatus.result?.isError, true, 'Even an administrator user cannot call the internal availability tool.');

    const apiKey = 'email-runtime-test-key-123456';
    const configured = await callTool('email_config_set', {
        MAILJET_API_KEY: apiKey,
        MAILJET_FROM_EMAIL: 'smoke@example.test',
    });
    assert.equal(configured.error, undefined, JSON.stringify(configured));
    assert.notEqual(configured.result?.isError, true, JSON.stringify(configured));
    const settings = JSON.parse(configured.result.content[0].text);
    assert.equal(settings.MAILJET_FROM_EMAIL, 'smoke@example.test', 'The tool must receive the signed MCP input');
    assert.notEqual(settings.MAILJET_API_KEY, apiKey);
    assert.match(settings.MAILJET_API_KEY, /^email-\*+3456$/);
    const retrieved = await callTool('email_config_get');
    assert.equal(retrieved.error, undefined, JSON.stringify(retrieved));
    assert.deepEqual(JSON.parse(retrieved.result.content[0].text), settings);

    const invalidInputs = [
        ['email_auth_code_status', { unexpected: true }],
        ['email_provider_status', { unexpected: true }],
        ['email_config_set', { remove: [42] }],
        ['email_send_text', { to: 'recipient@example.test', subject: 'Subject' }],
        ['email_send_text', { to: 'recipient@example.test', subject: '', text: 'Body' }],
        ['email_send_template', { to: 'recipient@example.test', templateId: '12', variables: [] }],
        ['email_send_auth_code', { to: 'recipient@example.test', code: '12345' }],
        ['email_send_auth_code', { to: 'recipient@example.test', code: '12345x' }],
    ];
    for (const [name, args] of invalidInputs) {
        const rejected = await callTool(name, args);
        assert.equal(rejected.error?.code, -32602, `${name} must reject invalid arguments: ${JSON.stringify(rejected)}`);
    }

    // An absent API secret stops delivery before any network request. Reaching
    // that error proves arbitrary nested template variables survive validation
    // and the signed request hash unchanged.
    const template = await callTool('email_send_template', {
        to: 'recipient@example.test',
        templateId: '12',
        variables: { code: '123456', details: { label: 'Nested' }, values: [1, 'two'] },
    }, { kind: 'agent', id: 'agent:AssistOSExplorer/userPersistoAgent', roles: [] });
    assert.equal(template.error, undefined, JSON.stringify(template));
    assert.equal(template.result?.isError, true, JSON.stringify(template));
    assert.match(template.result?.content?.[0]?.text || '', /MCP error -32603:.*Missing EmailAgent settings: MAILJET_API_SECRET/s);

    await callTool('email_config_set', { MAILJET_API_SECRET: 'fixture-only-secret' });
    const ready = await callTool('email_auth_code_status', {}, agentActor);
    assert.deepEqual(JSON.parse(ready.result.content[0].text), { available: true }, 'Readiness exposes only a boolean and never sends mail.');
    await callTool('email_config_set', { EMAIL_AUTH_CODE_TEMPLATE_ID: 'invalid-template' });
    const invalidTemplate = await callTool('email_auth_code_status', {}, agentActor);
    assert.deepEqual(JSON.parse(invalidTemplate.result.content[0].text), { available: false });

    const denied = await callTool('email_config_get', {}, { kind: 'user', id: 'user:email-member', roles: ['user'] });
    assert.equal(denied.error, undefined, JSON.stringify(denied));
    assert.equal(denied.result?.isError, true, JSON.stringify(denied));
    assert.match(denied.result?.content?.[0]?.text || '', /MCP error -32603:.*Admin access is required/s);
    const unsigned = await mcpRequest(port, {
        jsonrpc: '2.0',
        id: 'unsigned-call',
        method: 'tools/call',
        params: { name: 'email_config_get', arguments: {} },
    }, sessionId);
    assert.equal(unsigned.body.error, undefined, JSON.stringify(unsigned.body));
    assert.equal(unsigned.body.result?.isError, true, JSON.stringify(unsigned.body));
    assert.match(unsigned.body.result?.content?.[0]?.text || '', /MCP error -32600: Invocation rejected/);
});
