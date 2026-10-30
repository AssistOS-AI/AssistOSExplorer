import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { DEFAULT_ENV_ALLOWLIST, admitStartRequest, createAdmission } from '../../server/execution/supervisorRequestValidator.mjs';

// The first request each ALA adapter sends through the protocol provider, built with ALA's own code (describeProcessRequest and the
// OpenCode environment builder at the pinned checkout, ALA_ROOT), must pass the supervisor's admission. ALA forwards only the
// environment ADDITIONS (entries that differ from its own environment, plus the names it generated), so an inherited secret never
// appears in a request; the allowlist here is exactly what the adapters add.
if (!process.env.ALA_ROOT) throw new Error('ALA_ROOT is required: this test builds requests with the ALA checkout');
const load = (relative) => import(pathToFileURL(path.join(process.env.ALA_ROOT, relative)).href);
const { describeProcessRequest } = await load('src/coding-agents/provider-request.mjs');
const { openCodeEnvironment } = await load('src/coding-agents/opencode-server.mjs');

const admission = createAdmission({
    grants: [{ path: '/projects/g0', access: 'write' }], streamDirectory: '/stream',
    inventory: ['codex', 'claude', 'opencode', 'pi'].map((name) => ({ name }))
});
// What ALA's own process sees in the orchestration view (plan env of alaPlan.mjs plus the fixed channel variables).
const BASE_ENV = Object.freeze({ HOME: '/home/robot', ALA_EVENT_STREAM: '1', ALA_TASK_REPOSITORIES: '', ALA_SESSIONS: '/session', NODE_CHANNEL_FD: '3', NODE_CHANNEL_SERIALIZATION_MODE: 'json' });
const sandboxFor = (backend) => ({ backend, home: '/home/robot', folders: [{ target: '/projects/g0', writable: true }], ignoredPaths: [], provider: { kind: 'protocol' } });
const request = (backend, overrides) => describeProcessRequest({
    processClass: 'run', binary: backend, args: ['--version'], cwd: '/projects/g0', env: { ...BASE_ENV }, sandbox: sandboxFor(backend), stdio: ['ignore', 'pipe', 'pipe'], ...overrides
}, { baseEnv: BASE_ENV });

test('Codex, Claude Code and Pi first requests are admitted; their generated controls are exactly the allowlisted ones', () => {
    for (const [backend, expected] of [['codex', {}], ['claude', { IS_SANDBOX: '1', DISABLE_AUTOUPDATER: '1' }], ['pi', { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' }]]) {
        const described = request(backend, backend === 'codex' ? { args: ['exec', '--json', 'prompt'] } : {});
        assert.deepEqual(described.env, expected, backend);
        assert.equal(admitStartRequest(described, admission), null, backend);
    }
});

test('OpenCode: the version check and the loopback server are admitted, including OPENCODE_ENABLE_EXA and the generated password', () => {
    const { OPENCODE_CONFIG_CONTENT: _ignored, ...withoutOverlay } = BASE_ENV;
    const env = openCodeEnvironment(withoutOverlay, false, [{ name: 'local', url: 'http://127.0.0.1:4000/mcp' }]);
    const generatedEnv = ['OPENCODE_ENABLE_EXA', 'OPENCODE_CONFIG_CONTENT'];
    const version = request('opencode', { env, generatedEnv });
    assert.deepEqual(Object.keys(version.env).sort(), ['OPENCODE_CONFIG_CONTENT', 'OPENCODE_ENABLE_EXA']);
    assert.equal(version.env.OPENCODE_ENABLE_EXA, '0');
    assert.equal(admitStartRequest(version, admission), null);
    const serve = request('opencode', {
        processClass: 'service', args: ['serve', '--hostname', '127.0.0.1', '--port', '0'], env: { ...env, OPENCODE_SERVER_PASSWORD: 'p'.repeat(43) },
        generatedEnv: [...generatedEnv, 'OPENCODE_SERVER_PASSWORD'], stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.deepEqual(Object.keys(serve.env).sort(), ['OPENCODE_CONFIG_CONTENT', 'OPENCODE_ENABLE_EXA', 'OPENCODE_SERVER_PASSWORD']);
    assert.equal(admitStartRequest(serve, admission), null);
});

test('API keys, tokens and the provider-owned names stay refused', () => {
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'OPENCODE_STARTUP_TIMEOUT_MS', 'CODEX_HOME', 'HOME', 'XDG_CONFIG_HOME']) {
        const described = request('codex', { args: ['exec'] });
        const refused = admitStartRequest({ ...described, env: { [name]: 'x' } }, admission);
        assert.ok(refused, name);
        assert.match(refused.code, /environment_(not_allowed|owned_by_provider)/u, name);
    }
    assert.deepEqual([...DEFAULT_ENV_ALLOWLIST].sort(), ['DISABLE_AUTOUPDATER', 'IS_SANDBOX', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_ENABLE_EXA', 'OPENCODE_SERVER_PASSWORD', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK']);
});
