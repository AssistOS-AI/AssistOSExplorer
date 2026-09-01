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

test('install hook only verifies the immutable nested Podman image contract', async () => {
    const source = await readFile(join(AGENT_ROOT, 'scripts', 'install.sh'), 'utf8');

    assert.match(source, /\/opt\/roboteam-runtime\/contract-v3/);
    assert.match(source, /roboteam-runtime-v3/);
    for (const command of ['podman', 'fuse-overlayfs', 'pasta', 'node']) {
        assert.match(source, new RegExp(`\\b${command}\\b`));
    }
    for (const requiredPath of ['/opt/roboteam-runtime/storage.conf']) {
        assert.match(source, new RegExp(requiredPath.replaceAll('/', '\\/')));
    }
    assert.match(source, /podman version 6/);
    assert.doesNotMatch(source, /\b(?:apt|apt-get|curl|wget|npm|pnpm|yarn|git)\b/);
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
