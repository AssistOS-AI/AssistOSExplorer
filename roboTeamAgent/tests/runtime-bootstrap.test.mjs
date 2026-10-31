import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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

async function storageInitFixture(directory) {
    await writeFixture(directory, 'roboteam-podman-init', '#!/bin/sh\nexit "${STORAGE_INIT_EXIT:-0}"\n');
    await writeFixture(directory, 'required-skills.mjs', 'process.exit(Number(process.env.REQUIRED_SKILLS_EXIT || 0));\n');
    return `${directory}:${process.env.PATH}`;
}

// Starts a long-running launcher in its own process group so cleanup also
// reaches children that a failed drain could leave behind.
function startLauncher(t, command, args, env) {
    const child = spawn(command, args, {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`launcher timed out: ${args.join(' ')}\n${stderr}`)), 10000);
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal, stdout, stderr });
        });
    });
    t.after(() => {
        try {
            process.kill(-child.pid, 'SIGKILL');
        } catch {}
    });
    return { child, exited };
}

async function waitForFiles(paths, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!paths.every((filePath) => existsSync(filePath))) {
        if (Date.now() > deadline) throw new Error(`fixture did not start: ${paths.join(', ')}`);
        await delay(20);
    }
}

// Each fake child records that its TERM handler is installed. On TERM it waits
// for its configured delay, records its exit and exits with its drain status,
// so a launcher that stops waiting early exits before the exit record exists.
async function drainFixture(directory) {
    const fixturePath = await storageInitFixture(directory);
    const childSource = (role, variablePrefix) => `
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {
    setTimeout(() => {
        writeFileSync(${JSON.stringify(join(directory, `${role}-exited`))}, '');
        process.exit(Number(process.env.${variablePrefix}_DRAIN_EXIT || 0));
    }, Number(process.env.${variablePrefix}_DRAIN_DELAY_MS || 0));
});
writeFileSync(${JSON.stringify(join(directory, `${role}-ready`))}, '');
setInterval(() => {}, 1000);
`;
    const service = await writeFixture(directory, 'service.mjs', childSource('service', 'SERVICE'));
    const agentServerMain = await writeFixture(directory, 'agent-server.mjs', childSource('agent-server', 'AGENT_SERVER'));
    const agentServer = await writeFixture(directory, 'agent-server.sh', `#!/bin/sh\nexec node ${JSON.stringify(agentServerMain)}\n`);
    // The launcher runs its readiness check only after installing its traps.
    const check = await writeFixture(directory, 'check.mjs', `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(directory, 'service-checked'))}, '');
`);
    return {
        env: {
            PATH: fixturePath,
            ROBOTEAM_REQUIRED_SKILLS_CHECK: join(directory, 'required-skills.mjs'),
            ROBOTEAM_AGENT_SERVER_SCRIPT: agentServer,
            ROBOTEAM_SERVICE_MAIN: service,
            ROBOTEAM_SERVICE_CHECK: check,
        },
        ready: [join(directory, 'service-ready'), join(directory, 'agent-server-ready'), join(directory, 'service-checked')],
        exited: [join(directory, 'service-exited'), join(directory, 'agent-server-exited')],
    };
}

async function drainLauncher(t, command, args, fixture, env = {}) {
    const { child, exited } = startLauncher(t, command, args, { ...fixture.env, ...env });
    await waitForFiles(fixture.ready);
    child.kill('SIGTERM');
    return exited;
}

test('launcher generates a fresh shared token without logging or accepting a configured token', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'roboteam-bootstrap-token-'));
    const fixturePath = await storageInitFixture(directory);
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
            PATH: fixturePath,
            ROBOTEAM_REQUIRED_SKILLS_CHECK: join(directory, 'required-skills.mjs'),
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

test('manifest declares the required report repository alongside ALA', async () => {
    const manifest = JSON.parse(await readFile(join(AGENT_ROOT, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest['link-install'], [
        'https://github.com/AssistOS-AI/AdvancedLanguageAgent.git',
        'https://github.com/AssistOS-AI/DocumentationSkills.git',
    ]);
});

test('manifest selects runtime-only GUI images and the persistent tool cache', async () => {
    const manifest = JSON.parse(await readFile(join(AGENT_ROOT, 'manifest.json'), 'utf8'));
    const constants = await import('../server/constants.mjs');
    // The manifest declares only the optional exact coding-agent version pins and the worker
    // coordinator selector base; proxy secrets live in proxyAgent.
    assert.deepEqual(manifest.profiles.default.env, [
        'ROBOTEAM_CODEX_VERSION', 'ROBOTEAM_OPENCODE_VERSION', 'ROBOTEAM_PI_VERSION', 'ROBOTEAM_CLAUDE_VERSION',
        { name: 'ROBOTEAM_WORKER_COORDINATOR_BASE', value: '/base-agent-additional-server/robo-work/7000' },
    ]);

    assert.equal(constants.DESKTOP_IMAGE, 'docker.io/assistos/roboteam-desktop:runtime');
    assert.equal(constants.BROWSER_IMAGE, 'docker.io/assistos/roboteam-browser:runtime');
    assert.equal(constants.TOOL_CACHE_DIR, '/data/tool-cache');
    assert.equal(constants.TOOL_REFRESH_INTERVAL_MS, 21600000);
});

test('install hook verifies the runtime and prepares the persistent tool-cache root', async () => {
    const source = await readFile(join(AGENT_ROOT, 'scripts', 'install.sh'), 'utf8');

    assert.match(source, /\/opt\/roboteam-runtime\/contract-v6/);
    assert.match(source, /roboteam-runtime-v6/);
    assert.match(source, /runtime_initializer="\/usr\/local\/bin\/roboteam-podman-init"/);
    assert.match(source, /if \[ ! -x "\$runtime_initializer" \]; then/);
    assert.match(source, /if ! "\$runtime_initializer"; then/);
    assert.ok(source.indexOf('if ! "$runtime_initializer"; then') > source.indexOf('if [ -n "$missing" ]; then'));
    assert.ok(source.indexOf('if ! "$runtime_initializer"; then') < source.indexOf('node "$script_dir/prepare-data.mjs"'));
    for (const command of ['podman', 'fuse-overlayfs', 'pasta', 'node', 'npm', 'bwrap']) {
        assert.match(source, new RegExp(`\\b${command}\\b`));
    }
    assert.doesNotMatch(source, /command:codex/);
    assert.match(source, /prepare-data\.mjs/);
    assert.match(source, /NODE_OPTIONS= npm --version/);
    for (const requiredPath of ['/opt/roboteam-runtime/storage.conf']) {
        assert.match(source, new RegExp(requiredPath.replaceAll('/', '\\/')));
    }
    assert.match(source, /if ! podman_version=\$\(podman --version 2>\/dev\/null\) \|\| \[ "\$podman_version" != "podman version 5\.8\.7" \]; then/);
    assert.match(source, /podman-version:5\.8\.7/);
    assert.match(source, /force_mask = \"0700\"/);
    assert.match(source, /\/var\/lib\/roboteam-podman\/storage/);
    assert.match(source, /\/data\/podman\/images/);
    assert.match(source, /transient_store = true/);
    assert.match(source, /podman version 5\.8\.7/);
    assert.doesNotMatch(source, /podman-major|podman version 6/);
    assert.doesNotMatch(source, /\b(?:apt|apt-get|curl|wget|pnpm|yarn|git)\b/);
    assert.doesNotMatch(source, /npm\s+(?:install|ci)/);
});

test('AgentServer failure terminates the service and fails the container', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'roboteam-bootstrap-mcp-'));
    const fixturePath = await storageInitFixture(directory);
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
        PATH: fixturePath,
        ROBOTEAM_REQUIRED_SKILLS_CHECK: join(directory, 'required-skills.mjs'),
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
    const fixturePath = await storageInitFixture(directory);
    t.after(() => rm(directory, { recursive: true, force: true }));
    const peerStoppedPath = join(directory, 'agent-server-stopped');
    const agentServer = await writeFixture(directory, 'agent-server.sh', `#!/bin/sh
trap 'printf agent-server > "$PEER_STOPPED_PATH"; exit 0' TERM INT
while :; do sleep 0.05; done
`);
    const service = await writeFixture(directory, 'service.mjs', 'setTimeout(() => process.exit(0), 200);\n');
    const check = await writeFixture(directory, 'check.mjs', 'process.exit(0);\n');

    const result = await runScript(join(AGENT_ROOT, 'scripts', 'startAgent.sh'), {
        PATH: fixturePath,
        ROBOTEAM_REQUIRED_SKILLS_CHECK: join(directory, 'required-skills.mjs'),
        PEER_STOPPED_PATH: peerStoppedPath,
        ROBOTEAM_AGENT_SERVER_SCRIPT: agentServer,
        ROBOTEAM_SERVICE_MAIN: service,
        ROBOTEAM_SERVICE_CHECK: check,
    });

    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /service exited; stopping AgentServer/);
    assert.equal(await readFile(peerStoppedPath, 'utf8'), 'agent-server');
});

test('TERM stops the service and AgentServer and acknowledges a clean drain with exit 0', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'roboteam-bootstrap-drain-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fixture = await drainFixture(directory);

    const result = await drainLauncher(t, 'sh', [join(AGENT_ROOT, 'scripts', 'startAgent.sh')], fixture,
        { SERVICE_DRAIN_DELAY_MS: '150', AGENT_SERVER_DRAIN_DELAY_MS: '300' });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    for (const filePath of fixture.exited) await access(filePath);
    assert.match(result.stderr, /RoboTeam received TERM; stopping service and AgentServer/);
    assert.doesNotMatch(result.stderr, /RoboTeam drain failed/);
});

for (const { name, env, status } of [
    { name: 'the service shutdown fails', env: { SERVICE_DRAIN_EXIT: '5', AGENT_SERVER_DRAIN_DELAY_MS: '300' }, status: 5 },
    { name: 'the AgentServer shutdown fails', env: { AGENT_SERVER_DRAIN_EXIT: '6', SERVICE_DRAIN_DELAY_MS: '300' }, status: 6 },
    {
        name: 'both shutdowns fail, reporting the service first',
        env: { SERVICE_DRAIN_EXIT: '5', SERVICE_DRAIN_DELAY_MS: '300', AGENT_SERVER_DRAIN_EXIT: '6' },
        status: 5,
    },
]) {
    test(`TERM waits for both children and fails the drain when ${name}`, async (t) => {
        const directory = await mkdtemp(join(tmpdir(), 'roboteam-bootstrap-drain-failure-'));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const fixture = await drainFixture(directory);

        const result = await drainLauncher(t, 'sh', [join(AGENT_ROOT, 'scripts', 'startAgent.sh')], fixture, env);

        assert.equal(result.code, status, result.stderr);
        for (const filePath of fixture.exited) await access(filePath);
        assert.match(result.stderr, new RegExp(`RoboTeam drain failed with status ${status}\\n`));
    });
}

test('manifest runs the install hook and then execs the start script so the drain reaches it', async (t) => {
    const manifest = JSON.parse(await readFile(join(AGENT_ROOT, 'manifest.json'), 'utf8'));
    assert.equal(manifest.agent, 'exec sh /code/scripts/startAgent.sh');
    assert.equal(manifest.profiles.default.install, 'sh /code/scripts/install.sh');

    const directory = await mkdtemp(join(tmpdir(), 'roboteam-bootstrap-exec-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fixture = await drainFixture(directory);
    const installedPath = join(directory, 'installed');
    const install = await writeFixture(directory, 'install.sh', `#!/bin/sh\n: > ${JSON.stringify(installedPath)}\n`);
    const installCommand = manifest.profiles.default.install.replace('/code/scripts/install.sh', install);
    const agentCommand = manifest.agent.replace('/code/scripts/startAgent.sh', join(AGENT_ROOT, 'scripts', 'startAgent.sh'));
    // Ploinky composes `<shell> -c "cd <cwd> && <install> && <agent>"` and prefers /bin/bash.
    const shell = existsSync('/bin/bash') ? '/bin/bash' : 'sh';

    const result = await drainLauncher(t, shell, ['-c', `cd ${directory} && ${installCommand} && ${agentCommand}`], fixture);

    assert.equal(result.code, 0, result.stderr);
    await access(installedPath);
    for (const filePath of fixture.exited) await access(filePath);
});

test('storage initialization failure stops startup before either service', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'roboteam-bootstrap-storage-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fixturePath = await storageInitFixture(directory);
    const result = await runScript(join(AGENT_ROOT, 'scripts/startAgent.sh'), {
        PATH: fixturePath, STORAGE_INIT_EXIT: '19',
        ROBOTEAM_AGENT_SERVER_SCRIPT: '/nonexistent-agent-server',
        ROBOTEAM_SERVICE_MAIN: '/nonexistent-service',
    });
    assert.equal(result.code, 19);
    assert.equal(result.stdout + result.stderr, '');
});

test('required skill failure stops startup before MCP or HTTP can become ready', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'roboteam-bootstrap-skills-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fixturePath = await storageInitFixture(directory);
    const result = await runScript(join(AGENT_ROOT, 'scripts/startAgent.sh'), {
        PATH: fixturePath, REQUIRED_SKILLS_EXIT: '23',
        ROBOTEAM_REQUIRED_SKILLS_CHECK: join(directory, 'required-skills.mjs'),
        ROBOTEAM_AGENT_SERVER_SCRIPT: '/nonexistent-agent-server',
        ROBOTEAM_SERVICE_MAIN: '/nonexistent-service',
    });
    assert.equal(result.code, 23, result.stderr);
    assert.equal(result.stdout + result.stderr, '');
    const source = await readFile(join(AGENT_ROOT, 'scripts/startAgent.sh'), 'utf8');
    assert.ok(source.indexOf('node "$required_skills_check"') < source.indexOf('sh "$agent_server_script"'));
    assert.ok(source.indexOf('node "$required_skills_check"') < source.indexOf('node "$service_main"'));
});
