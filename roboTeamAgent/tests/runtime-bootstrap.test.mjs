import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = join(TEST_DIR, '..');

function runScript(scriptPath, env) {
    return new Promise((resolve, reject) => {
        const child = spawn('sh', [scriptPath], {
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`script timed out: ${scriptPath}`));
        }, 5000);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal, stdout, stderr });
        });
    });
}

async function writeFixture(directory, name, source) {
    const filePath = join(directory, name);
    await writeFile(filePath, source, { mode: 0o755 });
    return filePath;
}

test('launcher generates a fresh shared token without logging or accepting a configured token', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'roboteam-bootstrap-token-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fixture = await writeFixture(directory, 'token.mjs', `
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const token = process.env.ROBOTEAM_INTERNAL_TOKEN;
if (!/^[a-f0-9]{64}$/.test(token) || token === 'a'.repeat(64)) process.exit(9);
writeFileSync(process.env.TOKEN_CHECK_DIR + '/' + process.argv[2], createHash('sha256').update(token).digest('hex'));
setTimeout(() => process.exit(7), 200);
`);
    const service = await writeFixture(directory, 'service.mjs', `process.argv[2] = 'service'; await import(${JSON.stringify(new URL('file://' + fixture).href)});`);
    const agent = await writeFixture(directory, 'agent.sh', '#!/bin/sh\nexec node "$TOKEN_FIXTURE" mcp\n');
    const check = await writeFixture(directory, 'check.mjs', 'process.exit(0);');
    let previous;
    for (let run = 0; run < 2; run++) {
        const result = await runScript(join(AGENT_ROOT, 'scripts/startAgent.sh'), {
            ROBOTEAM_INTERNAL_TOKEN: 'a'.repeat(64), TOKEN_CHECK_DIR: directory, TOKEN_FIXTURE: fixture,
            ROBOTEAM_AGENT_SERVER_SCRIPT: agent, ROBOTEAM_SERVICE_MAIN: service, ROBOTEAM_SERVICE_CHECK: check,
        });
        assert.equal(result.code, 7, result.stderr);
        const digest = await readFile(join(directory, 'service'), 'utf8');
        assert.equal(await readFile(join(directory, 'mcp'), 'utf8'), digest);
        assert.notEqual(digest, previous);
        assert.doesNotMatch(result.stdout + result.stderr, /[a-f0-9]{64}/);
        previous = digest;
    }
});

test('manifest follows the operator-managed runtime channel', async () => {
    const manifest = JSON.parse(await readFile(join(AGENT_ROOT, 'manifest.json'), 'utf8'));

    assert.equal(manifest.container, 'docker.io/assistos/roboteam-agent:runtime');
});

test('manifest declares the MCP startup budget', async () => {
    const manifest = JSON.parse(await readFile(join(AGENT_ROOT, 'manifest.json'), 'utf8'));

    assert.deepEqual(manifest.readiness, {
        protocol: 'mcp',
        timeoutSeconds: 45,
    });
    assert.deepEqual(manifest.health.readiness, {
        interval: 1,
        timeout: 1,
        failureThreshold: 45,
        successThreshold: 1,
    });
});

test('manifest requests the bounded nested Podman capability', async () => {
    const manifest = JSON.parse(await readFile(join(AGENT_ROOT, 'manifest.json'), 'utf8'));

    assert.deepEqual(manifest.containerSecurity, { nestedPodman: true });
    assert.equal(manifest.network, undefined);
    assert.deepEqual(manifest.profiles.default.openPorts, ['7000:7000', '3001:3001']);
});

test('manifest stores RoboTeam state in the workspace private data tree', async () => {
    const manifest = JSON.parse(await readFile(join(AGENT_ROOT, 'manifest.json'), 'utf8'));

    assert.deepEqual(manifest.volumes, {
        '.data/roboTeamAgent': '/data',
    });
});

test('manifest selects runtime-only GUI images and the persistent tool cache', async () => {
    const manifest = JSON.parse(await readFile(join(AGENT_ROOT, 'manifest.json'), 'utf8'));
    const constants = await import('../server/constants.mjs');
    assert.equal(manifest.profiles.default.env, undefined);

    assert.equal(constants.DESKTOP_IMAGE, 'docker.io/assistos/roboteam-desktop:runtime');
    assert.equal(constants.BROWSER_IMAGE, 'docker.io/assistos/roboteam-browser:runtime');
    assert.equal(constants.TOOL_CACHE_DIR, '/data/tool-cache');
    assert.equal(constants.TOOL_REFRESH_INTERVAL_MS, 21600000);
});

test('install hook verifies the runtime and prepares the persistent tool-cache root', async () => {
    const source = await readFile(join(AGENT_ROOT, 'scripts', 'install.sh'), 'utf8');

    assert.match(source, /\/opt\/roboteam-runtime\/contract-v4/);
    assert.match(source, /roboteam-runtime-v4/);
    for (const command of ['podman', 'fuse-overlayfs', 'pasta', 'node', 'npm', 'bwrap']) {
        assert.match(source, new RegExp(`\\b${command}\\b`));
    }
    assert.doesNotMatch(source, /command:codex/);
    assert.match(source, /prepare-data\.mjs/);
    assert.match(source, /NODE_OPTIONS= npm --version/);
    for (const requiredPath of ['/opt/roboteam-runtime/storage.conf']) {
        assert.match(source, new RegExp(requiredPath.replaceAll('/', '\\/')));
    }
    assert.match(source, /podman version 6/);
    assert.doesNotMatch(source, /\b(?:apt|apt-get|curl|wget|pnpm|yarn|git)\b/);
    assert.doesNotMatch(source, /npm\s+(?:install|ci)/);
});

test('AgentServer failure terminates the service and fails the container', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'roboteam-bootstrap-mcp-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const peerStoppedPath = join(directory, 'service-stopped');
    const agentServer = await writeFixture(directory, 'agent-server.sh', '#!/bin/sh\nsleep 0.2\nexit 7\n');
    const service = await writeFixture(directory, 'service.mjs', `
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {
    writeFileSync(process.env.PEER_STOPPED_PATH, 'service');
    process.exit(0);
});
setInterval(() => {}, 1000);
`);
    const check = await writeFixture(directory, 'check.mjs', 'process.exit(0);\n');

    const result = await runScript(join(AGENT_ROOT, 'scripts', 'startAgent.sh'), {
        PEER_STOPPED_PATH: peerStoppedPath,
        ROBOTEAM_AGENT_SERVER_SCRIPT: agentServer,
        ROBOTEAM_SERVICE_MAIN: service,
        ROBOTEAM_SERVICE_CHECK: check,
    });

    assert.equal(result.code, 7, result.stderr);
    assert.match(result.stderr, /AgentServer exited; stopping service/);
    assert.equal(await readFile(peerStoppedPath, 'utf8'), 'service');
});

test('even a clean service exit terminates AgentServer and fails the container', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'roboteam-bootstrap-service-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const peerStoppedPath = join(directory, 'agent-server-stopped');
    const agentServer = await writeFixture(directory, 'agent-server.sh', `#!/bin/sh
trap 'printf agent-server > "$PEER_STOPPED_PATH"; exit 0' TERM INT
while :; do sleep 0.05; done
`);
    const service = await writeFixture(directory, 'service.mjs', 'setTimeout(() => process.exit(0), 200);\n');
    const check = await writeFixture(directory, 'check.mjs', 'process.exit(0);\n');

    const result = await runScript(join(AGENT_ROOT, 'scripts', 'startAgent.sh'), {
        PEER_STOPPED_PATH: peerStoppedPath,
        ROBOTEAM_AGENT_SERVER_SCRIPT: agentServer,
        ROBOTEAM_SERVICE_MAIN: service,
        ROBOTEAM_SERVICE_CHECK: check,
    });

    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /service exited; stopping AgentServer/);
    assert.equal(await readFile(peerStoppedPath, 'utf8'), 'agent-server');
});
