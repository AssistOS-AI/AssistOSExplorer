import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { collectCopilotReleaseEvidence, sameCopilotReleaseGeneration } from './copilot-release-evidence.mjs';
import { validateWorkspaceSourceMount } from './live-box.mjs';
import { liveSkillsHash, UUID } from './copilot-live-skills.mjs';

const CONTRACT_FILES = [
    'server/copilot-context.mjs', 'server/constants.mjs', 'server/robot-store.mjs',
    'server/live-skill-catalog.mjs', 'server/skill-catalog-api.mjs',
    'copilot/src/lib/conversationSessionStore.mjs', 'copilot/src/lib/robotSkillCatalog.mjs',
    'copilot/src/lib/alaEngine.mjs', 'copilot/src/lib/webchatRuntime.mjs',
];

function command(args, input = '') {
    return new Promise((resolve, reject) => {
        const child = spawn('podman', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks = [];
        let size = 0;
        const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
        child.stdout.on('data', (chunk) => {
            size += chunk.length;
            if (size > 8 * 1024 * 1024) child.kill('SIGKILL');
            else chunks.push(chunk);
        });
        // Raw Podman errors/inspect output can contain environment values. Report only operation failure.
        child.stderr.resume();
        child.on('error', () => { clearTimeout(timer); reject(new Error('Read-only Podman evidence collection could not start.')); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0 || size > 8 * 1024 * 1024) return reject(new Error('Read-only Podman evidence collection failed or exceeded its limit.'));
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { reject(new Error('Read-only Podman evidence was not valid JSON.')); }
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}

function program(fn, args) {
    return `(${fn.toString()})(${JSON.stringify(args)}).catch(() => { console.error('Invalid read-only runtime evidence'); process.exitCode = 1; });\n`;
}

// Executed inside the already pinned Box. Importing this observational reader does not create a registry.
async function readRegistryAndRuntime() {
    const assert = (await import('node:assert/strict')).default;
    const { execFileSync } = await import('node:child_process');
    const { readAgentRegistrySnapshot } = await import('/opt/ploinky/cli/utils/agentRegistrySnapshot.js');
    const rows = Object.entries(readAgentRegistrySnapshot({ workspaceRoot: '/workspace' }))
        .filter(([, row]) => row.type === 'agent' && row.repoName === 'AchillesCLI' && row.agentName === 'roboTeamAgent');
    assert.equal(rows.length, 1);
    const [key, row] = rows[0];
    assert.match(row.containerId, /^[0-9a-f]{64}$/);
    assert.equal(row.runtime, 'podman');
    const [runtime] = JSON.parse(execFileSync('podman', ['inspect', row.containerId], { encoding: 'utf8', timeout: 8_000, stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.equal(runtime.Id, row.containerId);
    assert.equal(runtime.State.Running, true);
    console.log(JSON.stringify({ key, containerId: row.containerId, instanceId: row.instanceId,
        enableGeneration: row.enableGeneration, startedAt: runtime.State.StartedAt, imageId: runtime.Image,
        mounts: runtime.Mounts.map(({ Type, Source, Destination, RW }) => ({ Type, Source, Destination, RW })) }));
}

// Executed inside the exact running RoboTeam container. Never instantiate RobotStore, execute helpers,
// update settings, or read native auth/progress. All paths below are derived and confined.
export async function readLiveSkillsSnapshot({ sessionId, folder, skillNames, contractFiles }) {
    const assert = (await import('node:assert/strict')).default;
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { createHash } = await import('node:crypto');
    const hash = value => createHash('sha256').update(value).digest('hex');
    assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(folder, /^copilot-live-skills-[0-9a-f-]{36}$/);
    const workspace = `/workspace/${folder}`;
    function bytes(filename, root, limit = 4 * 1024 * 1024) {
        assert.ok(filename.startsWith(`${root}/`));
        assert.equal(fs.realpathSync(filename), filename, 'Evidence path contains a symlink.');
        const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            const before = fs.fstatSync(fd);
            assert.ok(before.isFile() && before.nlink === 1 && before.size <= limit);
            const data = fs.readFileSync(fd);
            const after = fs.fstatSync(fd);
            assert.ok(before.size === data.length && before.size === after.size && before.mtimeMs === after.mtimeMs
                && before.ctimeMs === after.ctimeMs && fs.realpathSync(`/proc/self/fd/${fd}`) === filename);
            return data;
        } finally { fs.closeSync(fd); }
    }
    const json = (filename, root, limit) => JSON.parse(bytes(filename, root, limit));
    const robotRoots = [];
    for (const entry of fs.readdirSync('/data/robots', { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(entry.name)) continue;
        const root = `/data/robots/${entry.name}`;
        const metadata = json(`${root}/metadata.json`, root);
        if (metadata.name === 'default') { assert.equal(metadata.id, entry.name); robotRoots.push(root); }
    }
    assert.equal(robotRoots.length, 1);
    const robotRoot = robotRoots[0];
    const session = json(`${robotRoot}/copilot/sessions/${sessionId}.json`, robotRoot);
    assert.equal(session.sessionId, sessionId);
    assert.equal(session.cwd, workspace);
    let native = null;
    if (session.engine) {
        assert.equal(session.engine.home, `${robotRoot}/home`);
        assert.equal(session.engine.cwd, workspace);
        const nativeFile = `${session.engine.home}/.ala/sessions/${sessionId}.json`;
        if (fs.existsSync(nativeFile)) {
            const value = json(nativeFile, robotRoot);
            native = { version: value.version, id: value.id, home: value.home, workspace: value.workspace,
                agent: value.agent, continuation: { threadId: value.continuation?.threadId } };
        }
    }
    const capturedFiles = {};
    let catalog = null;
    if (session.skillExecution?.catalogPath) {
        const { catalogPath, revision } = session.skillExecution;
        assert.match(revision, /^[0-9a-f]{64}$/);
        assert.equal(catalogPath, `${robotRoot}/runtime/skill-catalogs/${revision}`);
        catalog = json(`${catalogPath}/.catalog.json`, robotRoot);
        for (const name of skillNames) {
            assert.match(name, /^live-[a-f0-9]{8}-(control|probe|added)$/);
            if (!catalog.entries.some(entry => entry.name === name)) continue;
            capturedFiles[name] = { descriptorSha256: hash(bytes(`${catalogPath}/${name}/SKILL.md`, robotRoot)),
                helperSha256: hash(bytes(`${catalogPath}/${name}/receipt.mjs`, robotRoot)) };
        }
    }
    const receipts = {};
    const receiptRoot = `${workspace}/.receipts`;
    for (const name of fs.readdirSync(receiptRoot)) {
        assert.match(name, /^[a-f0-9-]{36}-live-[a-f0-9]{8}-(control|probe|added)\.json$/);
        receipts[name] = json(`${receiptRoot}/${name}`, workspace, 4096);
    }
    const codeHashes = {};
    for (const file of contractFiles) {
        assert.ok(/^[a-zA-Z0-9/.-]+\.mjs$/.test(file) && !file.includes('..'));
        codeHashes[file] = hash(bytes(`/code/${file}`, '/code'));
    }
    console.log(JSON.stringify({ robotRoot, session: { sessionId: session.sessionId, cwd: session.cwd,
        engine: session.engine, skillPolicyRef: session.skillPolicyRef, skillExecution: session.skillExecution,
        messages: session.messages.map(({ id, role, text, status, turnId }) => ({ id, role, text, status, turnId })) },
        native, catalog, capturedFiles, receipts, codeHashes, capturedAt: new Date().toISOString() }));
}

export function validateLiveSkillsRuntimeBinding(runtime, expectedRepository) {
    assert.match(runtime.containerId, /^[0-9a-f]{64}$/);
    assert.match(runtime.instanceId, UUID);
    assert.match(runtime.enableGeneration, UUID);
    assert.ok(Number.isFinite(Date.parse(runtime.startedAt)));
    assert.match(runtime.imageId, /^sha256:[0-9a-f]{64}$|^[0-9a-f]{64}$/);
    const mount = (destination, source) => {
        const rows = runtime.mounts.filter(item => item.Destination === destination);
        assert.equal(rows.length, 1, `Runtime needs one exact ${destination} mount.`);
        assert.equal(rows[0].Type, 'bind');
        assert.equal(rows[0].Source, source);
        assert.equal(rows[0].RW, true);
    };
    mount('/workspace', '/workspace');
    mount('/data', '/workspace/.data/roboTeamAgent');
    mount(`${expectedRepository}/roboTeamAgent`, `${expectedRepository}/roboTeamAgent`);
    const code = runtime.mounts.filter(item => item.Destination === '/code');
    assert.equal(code.length, 1);
    assert.equal(code[0].Type, 'bind');
    assert.ok(code[0].Source.startsWith(`/workspace/.ploinky/container-runtime/${runtime.key}/code-`));
    return runtime;
}

export async function createLiveSkillsRuntimeReader({ env = process.env, baseURL, verifierPath }) {
    assert.ok(env.SMOKE_PLOINKY_BOX_CONTAINER, 'Set the exact SMOKE_PLOINKY_BOX_CONTAINER name.');
    assert.ok(env.SMOKE_BOX_BASE_URL, 'Set SMOKE_BOX_BASE_URL to the selected host Box loopback origin.');
    assert.ok(env.SMOKE_WORKSPACE_ROOT && path.isAbsolute(env.SMOKE_WORKSPACE_ROOT), 'Set an absolute SMOKE_WORKSPACE_ROOT on the selected host.');
    const hostWorkspace = fs.realpathSync(env.SMOKE_WORKSPACE_ROOT);
    const collect = () => collectCopilotReleaseEvidence({ manifestPath: env.SMOKE_RELEASE_MANIFEST,
        verifierPath, baseURL, boxBaseURL: env.SMOKE_BOX_BASE_URL,
        expectedContainerName: env.SMOKE_PLOINKY_BOX_CONTAINER, expectedImageRef: env.SMOKE_EXPECT_BOX_IMAGE_REF,
        generationMaxAgeMs: env.SMOKE_BOX_MAX_GENERATION_AGE_MS });
    const release = await collect();
    const box = release.liveBox.box;
    assert.match(box.containerId, /^[0-9a-f]{64}$/);
    const hostRepository = fs.realpathSync(release.repositories.achillesCLI.repositoryPath);
    const relative = path.relative(hostWorkspace, hostRepository);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Verified AchillesCLI must belong to the selected workspace.');
    const expectedRepository = `/workspace/${relative.split(path.sep).join('/')}`;
    const codeHashes = Object.fromEntries(CONTRACT_FILES.map(file => [file, liveSkillsHash(fs.readFileSync(path.join(hostRepository, 'roboTeamAgent', file)))]));
    let initialRuntime;
    async function binding() {
        const [outer] = await command(['inspect', box.containerId]);
        assert.equal(outer.Id, box.containerId);
        assert.equal(outer.State.Running, true);
        assert.equal(new Date(outer.State.StartedAt).toISOString(), new Date(box.startedAt).toISOString());
        assert.equal(outer.Image, box.imageId);
        validateWorkspaceSourceMount(outer.Mounts, hostWorkspace);
        const runtime = validateLiveSkillsRuntimeBinding(await command(['exec', '-i', '--user', 'podman', box.containerId,
            'node', '--input-type=module', '-'], program(readRegistryAndRuntime, {})), expectedRepository);
        if (initialRuntime) assert.deepEqual(runtime, initialRuntime, 'RoboTeam runtime was replaced, restarted or remounted during the test.');
        else initialRuntime = runtime;
        return runtime;
    }
    await binding();
    return {
        release,
        async capture({ sessionId, fixture }) {
            const runtime = await binding();
            const snapshot = await command(['exec', '-i', '--user', 'podman', box.containerId, 'podman', 'exec', '-i', runtime.containerId,
                'node', '--input-type=module', '-'], program(readLiveSkillsSnapshot, {
                sessionId, folder: fixture.folder, skillNames: [fixture.control.name, fixture.probe.name, fixture.added.name], contractFiles: CONTRACT_FILES,
            }));
            assert.deepEqual(snapshot.codeHashes, codeHashes, 'Running Copilot source differs from the verified checkout.');
            return snapshot;
        },
        async finish() {
            await binding();
            const after = await collect();
            assert.ok(sameCopilotReleaseGeneration(release, after), 'The release/Box generation changed during the live skill mutations.');
            return { release: after, runtime: initialRuntime, contractHashes: codeHashes };
        },
    };
}
