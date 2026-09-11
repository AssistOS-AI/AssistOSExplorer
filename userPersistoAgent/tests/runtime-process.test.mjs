import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const agentRoot = fileURLToPath(new URL('..', import.meta.url));
const runtimeRoot = process.env.PLOINKY_AGENT_RUNTIME_ROOT
    || fileURLToPath(new URL('../../../ploinky/Agent', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
// Generated per test process: the deployment administrator password is never a committed literal.
const ADMIN_PASSWORD = `runtime-${randomBytes(18).toString('base64url')}`;

async function freePort() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'userpersisto-runtime-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'persisto'));
    return root;
}

async function startRuntime(t, root, options = {}) {
    const servicePort = await freePort();
    let mcpPort;
    do { mcpPort = await freePort(); } while (mcpPort === servicePort);
    const env = {
        ...process.env,
        HOME: root,
        PERSISTENCE_FOLDER: join(root, 'persisto'),
        USERPERSISTO_SETTINGS_KEY: 'runtime-test-settings-key',
        USERPERSISTO_RUNTIME_SECRET: 'runtime-test-bridge-secret',
        USERPERSISTO_OIDC_ISSUER: '',
        USERPERSISTO_DEV_BOOTSTRAP: '',
        USERPERSISTO_ADMIN_PASSWORD: ADMIN_PASSWORD,
        USERPERSISTO_AUTH_METHODS: '',
        USERPERSISTO_SERVICE_PORT: String(servicePort),
        PORT: String(mcpPort),
        PLOINKY_AGENT_LIB_DIR: runtimeRoot,
        PLOINKY_AGENTLIB_DIR: process.env.PLOINKY_AGENTLIB_DIR
            || resolve(runtimeRoot, '../node_modules/achillesAgentLib'),
        PLOINKY_CODE_DIR: agentRoot,
        PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
        PLOINKY_AGENT_RUNTIME_ROOT: runtimeRoot,
        PLOINKY_INVOCATION_AUTH_MODULE: pathToFileURL(resolve(runtimeRoot, '../../AssistOSExplorer/shared/invocation-auth.mjs')).href,
        ...options.env,
    };
    const manifest = JSON.parse(await readFile(join(agentRoot, 'manifest.json'), 'utf8'));
    const agentCommand = manifest.agent.replace('/code/scripts/start.sh', shellQuote(join(agentRoot, 'scripts/start.sh')));
    const child = spawn('sh', ['-c', `cd ${shellQuote(agentRoot)} && ${agentCommand}`], {
        cwd: agentRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-32_768); });
    child.stderr.on('data', chunk => { output = `${output}${chunk}`.slice(-32_768); });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            await Promise.race([exited, delay(5000)]);
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
                await exited;
            }
        }
    });
    return {
        child, exited, env, servicePort: Number(env.USERPERSISTO_SERVICE_PORT),
        mcpPort: Number(env.PORT), output: () => output,
    };
}

async function waitFor(check, runtime) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        try { if (await check()) return; } catch {}
        if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) break;
        await delay(25);
    }
    assert.fail(`Runtime did not reach the expected state:\n${runtime.output()}`);
}

async function post(runtime, path, body, { bridge = false } = {}) {
    const response = await fetch(`http://127.0.0.1:${runtime.servicePort}${path}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(bridge ? { 'x-userpersisto-runtime-secret': runtime.env.USERPERSISTO_RUNTIME_SECRET } : {}),
        },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
}

async function registerOwner(runtime) {
    const request = await post(runtime, '/service/runtime/sso-login-request', {
        redirectUri: `http://127.0.0.1:${runtime.servicePort}/auth/callback`,
    }, { bridge: true });
    assert.equal(request.status, 200);
    // The first owner claims setup through the configured administrator password.
    const registered = await post(runtime, '/service/auth/admin/login', {
        requestId: request.body.request.providerState, password: ADMIN_PASSWORD,
    });
    assert.equal(registered.status, 200, JSON.stringify(registered.body));
    assert.equal(registered.body.initialAdministrator, true);
    const consumed = await post(runtime, '/service/runtime/sso-consume-code', {
        providerState: request.body.request.providerState, code: registered.body.code,
    }, { bridge: true });
    assert.equal(consumed.status, 200);
    return consumed.body.user.id;
}

async function fakeRuntime(root) {
    const fakeRoot = join(root, 'runtime');
    await mkdir(join(fakeRoot, 'server'), { recursive: true });
    await writeFile(join(fakeRoot, 'server/AgentServer.mjs'), `
import fs from 'node:fs/promises';
const statePath = process.env.RUNTIME_TEST_STATE;
const probe = async () => {
    const response = await fetch('http://127.0.0.1:' + process.env.USERPERSISTO_SERVICE_PORT + '/service/auth/setup');
    if (!response.ok) throw new Error('HTTP/store is not ready');
    return response.json();
};
await fs.writeFile(statePath + '.pending', JSON.stringify({ pid: process.pid, setup: await probe() }));
await fs.rename(statePath + '.pending', statePath);
const timer = setInterval(() => {}, 1000);
process.once('SIGTERM', async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    await fs.writeFile(statePath + '.drained', JSON.stringify(await probe()));
    clearInterval(timer);
});
`);
    return { PLOINKY_AGENT_LIB_DIR: fakeRoot, RUNTIME_TEST_STATE: join(root, 'runtime-state.json') };
}

test('MCP starts after the durable service and drains before HTTP/store; normal restart retains the owner', async t => {
    const root = await fixture(t);
    const env = await fakeRuntime(root);
    const runtime = await startRuntime(t, root, { env });
    await waitFor(() => existsSync(env.RUNTIME_TEST_STATE), runtime);
    const started = JSON.parse(await readFile(env.RUNTIME_TEST_STATE, 'utf8'));
    assert.equal(started.setup.setupComplete, false);
    assert.equal(started.setup.adminPassword, true);
    await registerOwner(runtime);
    assert.equal((await post(runtime, '/internal/tool', { name: 'userpersisto_profile_get' })).status, 401);
    runtime.child.kill('SIGTERM');
    assert.deepEqual(await runtime.exited, { code: 0, signal: null }, runtime.output());
    assert.equal(JSON.parse(await readFile(`${env.RUNTIME_TEST_STATE}.drained`, 'utf8')).setupComplete, true);
    assert.equal(existsSync(join(root, 'persisto/.userpersisto.writer.json')), false);
    await rm(env.RUNTIME_TEST_STATE);

    const restarted = await startRuntime(t, root, { env });
    await waitFor(() => existsSync(env.RUNTIME_TEST_STATE), restarted);
    assert.equal(JSON.parse(await readFile(env.RUNTIME_TEST_STATE, 'utf8')).setup.setupComplete, true);
    restarted.child.kill('SIGTERM');
    assert.deepEqual(await restarted.exited, { code: 0, signal: null }, restarted.output());
});

test('an abruptly killed runtime is replaced by a new generation without losing its owner', async t => {
    const root = await fixture(t);
    const env = await fakeRuntime(root);
    const runtime = await startRuntime(t, root, { env: {
        ...env,
        PLOINKY_AGENT_INSTANCE_ID: 'runtime-instance-before-box-restart',
        PLOINKY_AGENT_ENABLE_GENERATION: 'runtime-generation-before-box-restart',
    } });
    await waitFor(() => existsSync(env.RUNTIME_TEST_STATE), runtime);
    await registerOwner(runtime);
    const { pid: agentServerPid } = JSON.parse(await readFile(env.RUNTIME_TEST_STATE, 'utf8'));
    runtime.child.kill('SIGKILL');
    assert.deepEqual(await runtime.exited, { code: null, signal: 'SIGKILL' }, runtime.output());
    try { process.kill(agentServerPid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
    }
    assert.equal(existsSync(join(root, 'persisto/.userpersisto.writer.json')), true);
    await rm(env.RUNTIME_TEST_STATE);

    const restarted = await startRuntime(t, root, { env: {
        ...env,
        PLOINKY_AGENT_INSTANCE_ID: 'runtime-instance-after-box-restart',
        PLOINKY_AGENT_ENABLE_GENERATION: 'runtime-generation-after-box-restart',
    } });
    await waitFor(() => existsSync(env.RUNTIME_TEST_STATE), restarted);
    assert.equal(JSON.parse(await readFile(env.RUNTIME_TEST_STATE, 'utf8')).setup.setupComplete, true);
    const lockOwner = JSON.parse(await readFile(join(root, 'persisto/.userpersisto.writer.json'), 'utf8'));
    assert.equal(lockOwner.instanceId, 'runtime-instance-after-box-restart');
    assert.equal(lockOwner.enableGeneration, 'runtime-generation-after-box-restart');
    restarted.child.kill('SIGTERM');
    assert.deepEqual(await restarted.exited, { code: 0, signal: null }, restarted.output());
});

test('failed HTTP bind cannot expose MCP and releases the single-writer lock', async t => {
    const root = await fixture(t);
    const env = await fakeRuntime(root);
    const occupied = net.createServer();
    occupied.listen(0);
    await once(occupied, 'listening');
    t.after(() => new Promise(resolve => occupied.close(resolve)));
    const runtime = await startRuntime(t, root, {
        env: { ...env, USERPERSISTO_SERVICE_PORT: String(occupied.address().port) },
    });
    assert.deepEqual(await runtime.exited, { code: 1, signal: null });
    assert.equal(existsSync(env.RUNTIME_TEST_STATE), false);
    assert.equal(existsSync(join(root, 'persisto/.userpersisto.writer.json')), false);
});

test('an unexpected MCP exit stops HTTP and flushes the store with a failed runtime result', async t => {
    const root = await fixture(t);
    const env = await fakeRuntime(root);
    const runtime = await startRuntime(t, root, { env });
    await waitFor(() => existsSync(env.RUNTIME_TEST_STATE), runtime);
    const { pid } = JSON.parse(await readFile(env.RUNTIME_TEST_STATE, 'utf8'));
    process.kill(pid, 'SIGKILL');
    assert.deepEqual(await runtime.exited, { code: 1, signal: null }, runtime.output());
    await assert.rejects(fetch(`http://127.0.0.1:${runtime.servicePort}/service/auth/setup`));
    assert.equal(existsSync(join(root, 'persisto/.userpersisto.writer.json')), false);
});

test('the bundled AgentServer advertises every schema and forwards signed validated mutations to the HTTP store', async t => {
    const root = await fixture(t);
    const config = JSON.parse(await readFile(join(agentRoot, 'mcp-config.json'), 'utf8'));
    // Preserve the real tool definition and dispatcher; only translate /code
    // command paths for this host-process integration test.
    const profileTool = config.tools.find(tool => tool.name === 'userpersisto_profile_get');
    const configPath = join(root, 'mcp-config.json');
    await writeFile(configPath, JSON.stringify({ tools: config.tools.map(tool => ({
        ...tool, command: process.execPath,
        args: [join(agentRoot, 'tools/userpersisto_tool.mjs')], cwd: agentRoot,
    })) }));
    const secret = randomBytes(32);
    const audience = 'agent:AchillesIDE/userPersistoAgent';
    const runtime = await startRuntime(t, root, { env: {
        PLOINKY_AGENT_CONFIG: configPath,
        PLOINKY_AGENT_SECRET: secret.toString('hex'), PLOINKY_AGENT_ID: audience,
    } });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${runtime.mcpPort}/health`)).ok, runtime);
    const userId = await registerOwner(runtime);
    const mcp = async (body, { sessionId, token } = {}) => {
        const response = await fetch(`http://127.0.0.1:${runtime.mcpPort}/mcp`, {
            method: 'POST', headers: {
                'content-type': 'application/json', accept: 'application/json, text/event-stream',
                ...(sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' } : {}),
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            }, body: JSON.stringify(body),
        });
        return { response, body: await response.json() };
    };
    const initialized = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'userpersisto-runtime-test', version: '1.0' },
    } });
    assert.equal(initialized.response.status, 200);
    const sessionId = initialized.response.headers.get('mcp-session-id');
    assert.ok(sessionId);
    const listed = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { sessionId });
    assert.equal(listed.body.result.tools.length, config.tools.length);
    for (const tool of config.tools) {
        assert.deepEqual(listed.body.result.tools.find(entry => entry.name === tool.name).inputSchema, tool.inputSchema);
    }
    const call = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: profileTool.name, arguments: {} } };
    const unsigned = await mcp(call, { sessionId });
    assert.ok(unsigned.body.error || unsigned.body.result?.isError);
    const { signHmacJwt } = await import(pathToFileURL(join(runtimeRoot, 'lib/jwtSign.mjs')));
    const { computeRchTool } = await import(pathToFileURL(join(runtimeRoot, 'lib/requestHash.mjs')));
    let id = 4;
    const signedCall = (name, args) => {
        const now = Math.floor(Date.now() / 1000);
        const token = signHmacJwt({ secret, payload: {
            typ: 'router-request', iss: 'ploinky-router', aud: audience,
            sub: `user:${userId}`, actor: { kind: 'user', id: `user:${userId}`, roles: ['admin'] },
            method: 'POST', path: '/mcp', tool: name,
            rch: computeRchTool({ method: 'POST', path: '/mcp', tool: name, arguments: args }),
            jti: randomBytes(12).toString('hex'), iat: now, exp: now + 30,
        } });
        return mcp({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }, { sessionId, token });
    };
    const successful = async (name, args) => {
        const result = await signedCall(name, args);
        assert.equal(result.response.status, 200);
        assert.equal(result.body.error, undefined, JSON.stringify(result.body));
        assert.notEqual(result.body.result?.isError, true, JSON.stringify(result.body));
        return JSON.parse(result.body.result.content[0].text);
    };
    const profile = await successful(profileTool.name, {});
    assert.equal(profile.user.id, userId);
    assert.equal(profile.user.username, 'administrator');
    assert.equal(profile.user.email, '');
    assert.deepEqual(profile.authMethods, [{ type: 'adminPassword', name: 'Administrator password' }]);
    const updated = await successful('userpersisto_profile_update', { displayName: 'Runtime Owner' });
    assert.equal(updated.user.displayName, 'Runtime Owner');
    await successful('userpersisto_user_roles_update', { userId, roles: ['admin', 'user'] });
    const grant = { userId, amount: 7, referenceId: 'runtime-grant-1' };
    await successful('userpersisto_credits_grant', grant);
    const retried = await successful('userpersisto_credits_grant', grant);
    assert.equal(retried.idempotent, true);
    for (const [name, args] of [
        ['userpersisto_profile_update', {}],
        ['userpersisto_profile_update', { displayName: 'x'.repeat(201) }],
        ['userpersisto_profile_update', { displayName: 'invalid', extra: true }],
        ['userpersisto_user_roles_update', { userId }],
        ['userpersisto_user_roles_update', { userId, roles: [1] }],
        ['userpersisto_credits_grant', { ...grant, amount: -1 }],
        ['userpersisto_credits_grant', { ...grant, amount: 1.5 }],
    ]) {
        const result = await signedCall(name, args);
        assert.equal(result.body.error?.code, -32602, JSON.stringify(result.body));
    }
    assert.equal((await successful(profileTool.name, {})).user.displayName, 'Runtime Owner');
    assert.deepEqual(await successful('userpersisto_credits_balance', {}), { balance: 7, reservedBalance: 0 });
    runtime.child.kill('SIGTERM');
    assert.deepEqual(await runtime.exited, { code: 0, signal: null }, runtime.output());
    assert.equal(existsSync(join(root, 'persisto/.userpersisto.writer.json')), false);
});
