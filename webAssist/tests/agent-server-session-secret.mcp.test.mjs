import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createWebAssistSandbox, ensureSiteAku } from './helpers.mjs';
import { PLOINKY_ROOT_PATH as PLOINKY_LINK_PATH, WEBASSIST_ID } from './fixtures/verified-grant.mjs';

// D1: drives web_cli_chat and web_cli_history through the real AgentServer
// with webAssist's own mcp-config.json input schemas, and canonicalizes call
// arguments the way the Router does from the agent's tools/list. Only tool
// command paths are rewritten; inference is replaced by a preload stub.
const agentRoot = fileURLToPath(new URL('..', import.meta.url));
// AgentServer.mjs starts only when its argv path equals its real module URL,
// so a symlinked sibling checkout must be resolved first.
const PLOINKY_ROOT_PATH = await fs.realpath(PLOINKY_LINK_PATH);
const agentLibRoot = process.env.PLOINKY_AGENTLIB_DIR || path.join(PLOINKY_ROOT_PATH, 'node_modules/achillesAgentLib');
const { signHmacJwt } = await import(pathToFileURL(path.join(agentLibRoot, 'jwt/jwtSign.mjs')).href);
const { computeRchTool } = await import(pathToFileURL(path.join(PLOINKY_ROOT_PATH, 'Agent/lib/requestHash.mjs')).href);
const { sanitizeArgumentsForTool } = await import(pathToFileURL(path.join(PLOINKY_ROOT_PATH, 'cli/server/mcp-proxy/toolArguments.js')).href);
const STUB = pathToFileURL(path.join(agentRoot, 'tests/fixtures/agent-server-inference-stub.mjs')).href;
const SITE_ID = 'demo-site';

async function freePort() {
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const { port } = listener.address();
    await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    return port;
}

async function mcpRequest(port, body, sessionId, authorization) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (sessionId) {
        headers['mcp-session-id'] = sessionId;
        headers['mcp-protocol-version'] = '2025-06-18';
    }
    if (authorization) headers.authorization = authorization;
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return { headers: response.headers, body: JSON.parse(text) };
}

function rewriteCommands(config) {
    for (const tool of config.tools) {
        const script = path.join(agentRoot, String(tool.command).replace(/^\/code\//, ''));
        tool.args = [script, ...(Array.isArray(tool.args) ? tool.args : [])];
        tool.command = process.execPath;
    }
    return config;
}

test('sessionSecret reaches webAssist through the AgentServer schema path (D1)', { timeout: 90000 }, async (t) => {
    const sandbox = await createWebAssistSandbox();
    const stateDir = path.join(sandbox.sandboxRoot, 'agent-server');
    const recordDir = path.join(sandbox.sandboxRoot, 'inference-records');
    await fs.mkdir(stateDir);
    await fs.mkdir(recordDir);
    await ensureSiteAku({ siteId: SITE_ID });

    const config = rewriteCommands(JSON.parse(await fs.readFile(path.join(agentRoot, 'mcp-config.json'), 'utf8')));
    const configPath = path.join(stateDir, 'mcp-config.json');
    await fs.writeFile(configPath, JSON.stringify(config));
    const secret = randomBytes(32);
    const port = await freePort();
    const child = spawn('/bin/sh', [path.join(PLOINKY_ROOT_PATH, 'Agent/server/AgentServer.sh')], {
        cwd: stateDir,
        // Minimal environment: no host provider credentials reach the agent.
        env: {
            PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
            NODE_OPTIONS: `--import=${STUB}`,
            PORT: String(port),
            PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
            PLOINKY_AGENT_LIB_DIR: path.join(PLOINKY_ROOT_PATH, 'Agent'),
            PLOINKY_AGENTLIB_DIR: agentLibRoot,
            PLOINKY_AGENT_CONFIG: configPath,
            PLOINKY_AGENT_MANIFEST: path.join(agentRoot, 'manifest.json'),
            PLOINKY_CODE_DIR: agentRoot,
            PLOINKY_AGENT_ID: WEBASSIST_ID,
            PLOINKY_AGENT_SECRET: secret.toString('hex'),
            PLOINKY_INVOCATION_AUTH_MODULE: pathToFileURL(path.join(PLOINKY_ROOT_PATH, 'Agent/lib/invocation-auth.mjs')).href,
            PLOINKY_AGENT_TOOL_DEBUG_LOGS: '1',
            WEBASSIST_DATA_ROOT: sandbox.webAssistDataDir,
            WEBASSIST_TEST_INFERENCE_RECORD_DIR: recordDir,
            HOME: sandbox.sandboxRoot,
            TMPDIR: sandbox.sandboxRoot,
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
            await Promise.race([exited, delay(3000)]);
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
                await exited;
            }
        }
        await sandbox.cleanup();
    });

    const deadline = Date.now() + 20000;
    let healthy = false;
    while (Date.now() < deadline && child.exitCode === null) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
            await response.text();
            if (response.ok) { healthy = true; break; }
        } catch {
            // The server is still binding its socket.
        }
        await delay(50);
    }
    assert.ok(healthy, `webAssist AgentServer did not become healthy:\n${output}`);

    const initialized = await mcpRequest(port, {
        jsonrpc: '2.0', id: 'initialize', method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'webassist-d1-test', version: '1.0.0' } },
    });
    const mcpSessionId = initialized.headers.get('mcp-session-id');
    assert.ok(mcpSessionId);
    const listed = await mcpRequest(port, { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} }, mcpSessionId);
    const tools = listed.body.result.tools;
    for (const name of ['web_cli_chat', 'web_cli_history']) {
        const schema = tools.find((tool) => tool.name === name)?.inputSchema;
        t.diagnostic(`${name} tools/list inputSchema: ${JSON.stringify(schema)}`);
        assert.equal(schema?.properties?.sessionSecret?.type, 'string', `${name} declares sessionSecret`);
        assert.equal((schema.required || []).includes('sessionSecret'), false, `${name} keeps sessionSecret optional`);
    }

    async function rawCall(name, rawArgs, actor) {
        // The Router canonicalizes arguments against the agent's tools/list.
        const args = sanitizeArgumentsForTool(rawArgs, tools, name);
        const now = Math.floor(Date.now() / 1000);
        const token = signHmacJwt({
            secret,
            payload: {
                typ: 'router-request', iss: 'ploinky-router', aud: WEBASSIST_ID, sub: actor.id, actor,
                method: 'POST', path: '/mcp', tool: name,
                rch: computeRchTool({ method: 'POST', path: '/mcp', tool: name, arguments: args }),
                jti: randomUUID(), iat: now, exp: now + 60,
            },
        });
        return (await mcpRequest(port, { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }, mcpSessionId, `Bearer ${token}`)).body;
    }

    async function callTool(name, rawArgs, guestId) {
        const subject = `user:guest:${guestId}`;
        const body = await rawCall(name, rawArgs, { kind: 'guest', id: subject, roles: ['guest'] });
        assert.equal(body.error, undefined, JSON.stringify(body));
        assert.notEqual(body.result?.isError, true, JSON.stringify(body));
        return { raw: JSON.stringify(body), payload: JSON.parse(body.result.content[0].text) };
    }

    // S1 through the real server: the guest denial text reaches the MCP client.
    const deniedSites = JSON.stringify(await rawCall('list-sites', {}, { kind: 'guest', id: `user:guest:${randomUUID()}`, roles: ['guest'] }));
    t.diagnostic(`guest list-sites response: ${deniedSites}`);
    assert.match(deniedSites, /Access denied: Explorer access is required to list webAssist sites\./);
    assert.equal(deniedSites.includes(sandbox.webAssistDataDir), false);
    const adminSites = await rawCall('list-sites', {}, { kind: 'user', id: 'user:owner-1', roles: ['admin'], capabilities: ['explorer.access'] });
    assert.deepEqual(JSON.parse(adminSites.result.content[0].text), { sites: [SITE_ID], count: 1 });

    const guestA = randomUUID();
    const guestB = randomUUID();
    const created = await callTool('web_cli_chat', { siteId: SITE_ID, message: 'D1-OWNER-TURN', json: true }, guestA);
    const { sessionId, sessionSecret } = created.payload;
    assert.match(sessionSecret, /^[A-Za-z0-9_-]{43}$/);

    const continued = await callTool('web_cli_chat', { siteId: SITE_ID, sessionId, sessionSecret, message: 'D1-SECOND-TURN', json: true }, guestB);
    assert.equal(continued.payload.sessionId, sessionId, 'the secret continued the session for another guest');
    assert.equal(Object.hasOwn(continued.payload, 'sessionSecret'), false);

    const rotated = await callTool('web_cli_chat', { siteId: SITE_ID, sessionId, message: 'D1-NO-SECRET', json: true }, guestB);
    assert.notEqual(rotated.payload.sessionId, sessionId, 'no secret rotates for a non-owner');

    const read = await callTool('web_cli_history', { siteId: SITE_ID, sessionId, sessionSecret }, guestB);
    assert.equal(read.payload.exists, true);
    assert.deepEqual(read.payload.history.map((entry) => entry.message), ['D1-OWNER-TURN', 'Stubbed webAssist answer.', 'D1-SECOND-TURN', 'Stubbed webAssist answer.']);
    t.diagnostic(`web_cli_history success payload keys: ${JSON.stringify(Object.keys(read.payload))}`);

    const missing = { siteId: SITE_ID, sessionId, exists: false, sessionKuId: `ku_sess_${sessionId}`, history: [] };
    assert.deepEqual((await callTool('web_cli_history', { siteId: SITE_ID, sessionId }, guestB)).payload, missing);
    assert.deepEqual((await callTool('web_cli_history', { siteId: SITE_ID, sessionId, sessionSecret: randomBytes(32).toString('base64url') }, guestB)).payload, missing);
    assert.equal((await callTool('web_cli_history', { siteId: SITE_ID, sessionId }, guestA)).payload.exists, true);

    // Exposure: AgentServer debug logs, inference inputs and storage never hold the secret.
    await delay(200);
    assert.ok(output.includes("Tool 'web_cli_chat' payload"), 'tool debug logging was enabled');
    assert.equal(output.includes(sessionSecret), false, 'AgentServer output contains the secret');
    assert.match(output, /"sessionSecret":"\[redacted\]"/);
    const records = await fs.readdir(recordDir);
    assert.equal(records.length, 3);
    for (const name of records) {
        const record = await fs.readFile(path.join(recordDir, name), 'utf8');
        assert.equal(record.includes(sessionSecret), false, 'inference input contains the secret');
        assert.deepEqual(Object.keys(JSON.parse(record).context).sort(), ['sessionId', 'siteDataDir', 'siteId']);
    }
    const stack = [sandbox.webAssistDataDir];
    while (stack.length) {
        const dir = stack.pop();
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else assert.equal((await fs.readFile(full, 'latin1')).includes(sessionSecret), false, `${full} contains the secret`);
        }
    }
});
