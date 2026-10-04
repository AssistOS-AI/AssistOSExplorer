import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { assertBoxWorkspacePath, inspectBoxWorkspace } from './box-workspace.mjs';
import { collectCopilotReleaseEvidence, sameCopilotReleaseGeneration } from './copilot-release-evidence.mjs';
import { validateWorkspaceSourceMount } from './live-box.mjs';
import { liveSkillsHash, liveSkillsWorkspace, UUID } from './copilot-live-skills.mjs';
import { operateLiveSkillsFixture } from './copilot-live-skills-fixture-runtime.mjs';
import { inside, requireMount, rejectShadows } from './local-snapshot-bindings.mjs';

const CONTRACT_FILES = Object.freeze([
    'server/soul-gateway-service.mjs', 'server/soul-gateway-opencode.mjs',
    'server/soul-gateway-connection.mjs', 'server/agent-model-config.mjs',
    'server/robot-skillsets.mjs', 'server/skill-policy.mjs', 'server/skill-files.mjs', 'server/copilot-skillset.mjs',
    'server/skill-descriptor.mjs', 'server/skillsetMDParser.mjs', 'server/workspace-skill-source.mjs',
    'server/required-skills.mjs', 'server/skill-repository-source.mjs', 'server/project-storage.mjs',
    'server/repository-client.mjs', 'server/coding-agents.mjs', 'server/robot-shell.mjs',
    'server/ala-command.mjs', 'server/workspace-root.mjs', 'copilot/src/lib/config/achillesSettings.mjs',
    'copilot/src/lib/storage/privateDataRoot.mjs', 'copilot/src/lib/storage/workspaceStateLock.mjs',
    'copilot/src/permissions/protocol.mjs',
    'server/copilot-context.mjs', 'server/constants.mjs', 'server/robot-store.mjs',
    'server/live-skill-catalog.mjs', 'server/live-skill-install.mjs', 'server/skill-catalog-api.mjs',
    'copilot/src/lib/storage/conversationSessionStore.mjs', 'copilot/src/lib/skills/robotSkillCatalog.mjs',
    'copilot/src/lib/execution/alaEngine.mjs', 'copilot/src/lib/execution/alaTranscript.mjs', 'copilot/src/lib/webchat/webchatRuntime.mjs',
]);

export { CONTRACT_FILES as LIVE_SKILLS_CONTRACT_FILES };

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

// The function source is shipped to the Box, so it may reference no module binding. Every path travels as a JSON value.
export function program(fn, args) {
    const helpers = fn === readLiveSkillsSnapshot ? `const readLiveSkillsCodeHashes = ${readLiveSkillsCodeHashes.toString()};\n` : '';
    return `${helpers}(${fn.toString()})(${JSON.stringify(args)}).catch(() => { console.error('Invalid read-only runtime evidence'); process.exitCode = 1; });\n`;
}

export function normalizeLiveSkillsImageId(value) {
    assert.ok(typeof value === 'string' && /^(?:sha256:)?[0-9a-f]{64}$/.test(value), 'Expected one complete SHA-256 image identity.');
    return value.replace(/^sha256:/, '');
}

// Ploinky links /code entries into this already verified repository mount.
// This helper is serialized with the snapshot reader; keep its imports local.
export async function readLiveSkillsCodeHashes({ expectedRepository, contractFiles }, { codeRoot = '/code', fsApi } = {}) {
    const assert = (await import('node:assert/strict')).default;
    const fs = fsApi || await import('node:fs');
    const path = await import('node:path');
    const { createHash } = await import('node:crypto');
    assert.ok(typeof expectedRepository === 'string' && path.isAbsolute(expectedRepository)
        && path.normalize(expectedRepository) === expectedRepository);
    const sourceRoot = `${expectedRepository}/roboTeamAgent`;
    assert.equal(fs.realpathSync(sourceRoot), sourceRoot, 'Verified RoboTeam source must remain canonical.');
    assert.ok(Array.isArray(contractFiles) && contractFiles.length > 0 && new Set(contractFiles).size === contractFiles.length);
    const hashes = {};
    for (const file of contractFiles) {
        assert.ok(typeof file === 'string' && /^[a-zA-Z0-9/.-]+\.mjs$/.test(file)
            && !path.isAbsolute(file) && file.split('/').every(part => part && part !== '.' && part !== '..'));
        const filename = `${sourceRoot}/${file}`;
        const runtimeFile = `${codeRoot}/${file}`;
        assert.equal(fs.realpathSync(filename), filename, 'Verified contract source contains a symlink.');
        assert.equal(fs.realpathSync(runtimeFile), filename, 'Runtime contract file resolves outside its exact verified source.');
        const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            const before = fs.fstatSync(fd);
            assert.ok(before.isFile() && before.nlink === 1 && before.size <= 4 * 1024 * 1024);
            const data = fs.readFileSync(fd);
            const after = fs.fstatSync(fd);
            assert.ok(before.size === data.length && before.size === after.size && before.mtimeMs === after.mtimeMs
                && before.ctimeMs === after.ctimeMs && fs.realpathSync(`/proc/self/fd/${fd}`) === filename,
            'Verified contract file changed during its read.');
            assert.equal(fs.realpathSync(filename), filename);
            assert.equal(fs.realpathSync(runtimeFile), filename, 'Runtime contract link changed during its read.');
            hashes[file] = createHash('sha256').update(data).digest('hex');
        } finally { fs.closeSync(fd); }
    }
    return hashes;
}

// Executed inside the already pinned Box. Importing this observational reader does not create a registry.
export async function readRegistryAndRuntime({ workspaceRoot }) {
    const assert = (await import('node:assert/strict')).default;
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const { readAgentRegistrySnapshot } = await import('/opt/ploinky/cli/utils/agentRegistrySnapshot.js');
    // The Box mounts the workspace at its own host path; the admitted root is never the retired /workspace alias.
    assert.ok(typeof workspaceRoot === 'string' && path.isAbsolute(workspaceRoot) && path.normalize(workspaceRoot) === workspaceRoot
        && workspaceRoot !== '/' && !workspaceRoot.endsWith('/'));
    const rows = Object.entries(readAgentRegistrySnapshot({ workspaceRoot }))
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
// `/data` and `/code` are runtime locations of the RoboTeam container. The workspace root is the admitted host path.
export async function readLiveSkillsSnapshot({ sessionId, folder, skillNames, contractFiles, expectedRepository, workspaceRoot,
    robotId, robotName, repositoryName, repositoryRoot, expectedAla },
    { dataRoot = '/data', codeRoot = '/code', fsApi, emit = value => console.log(JSON.stringify(value)) } = {}) {
    const assert = (await import('node:assert/strict')).default;
    const fs = fsApi || await import('node:fs');
    const path = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const { createHash } = await import('node:crypto');
    const hash = value => createHash('sha256').update(value).digest('hex');
    assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(folder, /^copilot-live-skills-[0-9a-f-]{36}$/);
    assert.match(robotId || '', /^[a-z0-9][a-z0-9-]{2,63}$/, 'An explicit owned robot ID is required.');
    assert.equal(robotName, `copilot-live-${folder.slice('copilot-live-skills-'.length)}`);
    assert.equal(repositoryName, `copilot-live-source-${folder.slice('copilot-live-skills-'.length)}`);
    assert.ok(typeof workspaceRoot === 'string' && path.isAbsolute(workspaceRoot) && path.normalize(workspaceRoot) === workspaceRoot
        && workspaceRoot !== '/' && !workspaceRoot.endsWith('/'));
    assert.equal(fs.realpathSync(workspaceRoot), workspaceRoot, 'The admitted workspace root must be canonical.');
    assert.ok(typeof expectedRepository === 'string' && expectedRepository.startsWith(`${workspaceRoot}/`));
    const workspace = `${workspaceRoot}/${folder}`;
    assert.equal(fs.realpathSync(workspace), workspace, 'The run folder must be a real directory inside the admitted root.');
    assert.equal(repositoryRoot, `${workspaceRoot}/${repositoryName}`);
    assert.equal(fs.realpathSync(repositoryRoot), repositoryRoot, 'Registered fixture source must remain canonical.');
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
    const robotRoot = `${dataRoot}/robots/${robotId}`;
    assert.equal(fs.realpathSync(robotRoot), robotRoot);
    const robotFile = `${robotRoot}/metadata.json`;
    const robotBytes = bytes(robotFile, robotRoot);
    const metadata = JSON.parse(robotBytes);
    assert.equal(metadata.schema, 'roboteam-robot-v1');
    assert.equal(metadata.id, robotId);
    assert.equal(metadata.name, robotName);
    const registered = (metadata.skillsets || []).filter(source => source.name === repositoryName);
    assert.equal(registered.length, 1, 'Fixture source is not registered on the owned robot.');
    assert.equal(registered[0].source, repositoryRoot);
    assert.match(registered[0].generation, /^[0-9a-f-]{36}$/);
    const codeHashes = await readLiveSkillsCodeHashes({ expectedRepository, contractFiles }, { codeRoot, fsApi });
    const sessionFile = `${workspace}/.roboteam/sessions/${sessionId}.json`;
    const sessionBytes = bytes(sessionFile, workspace);
    const saved = JSON.parse(sessionBytes);
    assert.equal(saved.version, 2);
    assert.equal(saved.sessionId, sessionId);
    assert.equal(saved.cwd, workspace);
    if (saved.engine) {
        assert.equal(saved.engine.robotId, robotId);
        assert.equal(saved.engine.home, `${robotRoot}/home`);
        assert.equal(fs.realpathSync(saved.engine.home), saved.engine.home);
        assert.equal(saved.engine.cwd, workspace);
    }
    const transcriptFile = `${workspace}/.roboteam/.ala/sessions/${sessionId}.jsonl`;
    const transcriptBytes = fs.existsSync(transcriptFile) ? bytes(transcriptFile, workspace) : null;
    // Bind the supported reader to the explicitly selected deployed ALA package before importing it.
    assert.ok(expectedAla && expectedAla.root.startsWith(`${workspaceRoot}/`));
    const { resolveAlaCommand } = await import(pathToFileURL(`${codeRoot}/server/ala-command.mjs`).href);
    const actualCommand = fs.realpathSync(process.env.ACHILLES_ALA_COMMAND || resolveAlaCommand());
    assert.equal(actualCommand, expectedAla.command, 'Deployed ALA command differs from the selected source.');
    const alaHashes = {};
    for (const file of ['package.json', 'bin/ala.mjs', 'src/transcript.mjs']) {
        alaHashes[file] = hash(bytes(`${expectedAla.root}/${file}`, expectedAla.root));
    }
    assert.deepEqual(alaHashes, expectedAla.hashes, 'Deployed ALA reader differs from its pinned source.');
    assert.equal(JSON.parse(bytes(`${expectedAla.root}/package.json`, expectedAla.root)).name, 'advanced-language-agent');
    // Resolve ALA through the deployed RoboTeam adapter, whose exact source is included in contract hashes.
    const { alaTranscript, alaSessionsRoot } = await import(pathToFileURL(`${codeRoot}/copilot/src/lib/execution/alaTranscript.mjs`).href);
    const { ConversationSessionStore } = await import(pathToFileURL(`${codeRoot}/copilot/src/lib/storage/conversationSessionStore.mjs`).href);
    const session = new ConversationSessionStore({ workingDir: workspace }).loadSession(sessionId);
    const nativeSession = transcriptBytes === null ? null : alaTranscript.readSessionSync(alaSessionsRoot(workspace), sessionId);
    assert.equal(hash(bytes(sessionFile, workspace)), hash(sessionBytes), 'Session metadata changed during composition.');
    if (transcriptBytes !== null) assert.equal(hash(bytes(transcriptFile, workspace)), hash(transcriptBytes), 'ALA transcript changed during composition.');
    for (const turn of saved.turns.filter(turn => turn.context !== false && turn.status === 'completed')) {
        const matches = (nativeSession?.turns || []).filter(native => native.turnId === turn.turnId);
        assert.equal(matches.length, 1, 'Completed browser turn lacks its ALA transcript turn.');
        assert.equal(matches[0].status, 'completed', 'Completed browser turn has a failed native outcome.');
        assert.equal(typeof matches[0].final, 'string', 'Completed browser turn lacks an ALA final record.');
    }
    if (nativeSession?.continuation?.threadId !== undefined) assert.match(nativeSession.continuation.threadId, /^[A-Za-z0-9_-]{1,128}$/);
    // Presentation links are RoboTeam metadata, separate from ALA's raw final text.
    // Carry only the exact session/message binding; never render or project the recorded thinking log.
    const presentations = saved.turns.filter(turn => typeof turn.thinkingUrl === 'string' && turn.thinkingUrl.length > 0)
        .map(({ turnId, assistantMessageId, thinkingUrl }) => {
            assert.equal(thinkingUrl, `/base-agent-additional-server/roboTeamAgent/3001/webchat-logs/${sessionId}/${assistantMessageId}`,
                'Thinking link must remain on this session/message route.');
            return { turnId, assistantMessageId, thinkingUrl };
        });
    const native = nativeSession === null ? null : { id: nativeSession.id, home: saved.engine?.home,
        workspace: saved.engine?.cwd, agent: nativeSession.agent,
        continuation: { threadId: nativeSession.continuation?.threadId },
        turns: nativeSession.turns.map(({ turnId, user, final, status, startedAt, endedAt }) => ({ turnId, user, final, status, startedAt, endedAt })) };
    const capturedFiles = {}, liveLinks = {};
    let catalog = null;
    if (session.skillExecution) {
        assert.equal(session.skillExecution.live, true, 'Copied catalogs are not live execution evidence.');
        const recordFile = `${workspace}/.agents/.roboteam-links.json`;
        const recordBytes = bytes(recordFile, workspace);
        const links = JSON.parse(recordBytes);
        assert.ok(Array.isArray(links));
        assert.equal(hash(JSON.stringify(links)), session.skillExecution.revision);
        const destinations = new Set();
        for (const link of links) {
            assert.equal(path.dirname(link.destination), `${workspace}/.agents/skills`);
            assert.ok(!destinations.has(link.destination), 'Duplicate managed link destination.');
            destinations.add(link.destination);
            assert.ok(fs.lstatSync(link.destination).isSymbolicLink(), 'Installed skill must be an actual symlink.');
            assert.equal(fs.readlinkSync(link.destination), link.linkTarget);
        }
        catalog = { revision: session.skillExecution.revision, links, entries: session.skillExecution.entries };
        for (const name of skillNames) {
            assert.match(name, /^live-[a-f0-9]{8}-(control|probe|added)$/);
            const entries = catalog.entries.filter(entry => entry.name === name);
            if (!entries.length) {
                assert.ok(!destinations.has(`${workspace}/.agents/skills/${name}`), 'Absent skill remains installed.');
                assert.ok(!fs.existsSync(`${workspace}/.agents/skills/${name}`), 'Absent skill remains linked.');
                continue;
            }
            assert.equal(entries.length, 1);
            const source = `${repositoryRoot}/skills/${name}`;
            const destination = `${workspace}/.agents/skills/${name}`;
            const selected = links.filter(link => link.destination === destination);
            assert.equal(selected.length, 1, 'Selected fixture skill lacks its managed link.');
            const [link] = selected;
            assert.equal(entries[0].identity, `${repositoryName}/${name}`);
            assert.equal(entries[0].sourcePath, source);
            assert.equal(link.repoName, repositoryName);
            assert.equal(link.sourcePath, `skills/${name}`);
            assert.equal(path.resolve(path.dirname(destination), link.linkTarget), source);
            assert.equal(fs.realpathSync(destination), source, 'Live skill link was retargeted.');
            capturedFiles[name] = { descriptorSha256: hash(bytes(`${source}/SKILL.md`, repositoryRoot)),
                helperSha256: hash(bytes(`${source}/receipt.mjs`, repositoryRoot)) };
            assert.equal(fs.realpathSync(destination), source, 'Live link changed during source read.');
            assert.equal(fs.readlinkSync(destination), link.linkTarget);
            liveLinks[name] = { destination, linkTarget: link.linkTarget, resolvedSource: source };
        }
        assert.equal(hash(bytes(recordFile, workspace)), hash(recordBytes), 'Managed links changed during source read.');
    }
    const receipts = {};
    const receiptRoot = `${workspace}/.receipts`;
    assert.equal(fs.realpathSync(receiptRoot), receiptRoot, 'The receipts directory escapes the run folder.');
    for (const name of fs.readdirSync(receiptRoot)) {
        assert.match(name, /^[a-f0-9-]{36}-live-[a-f0-9]{8}-(control|probe|added)\.json$/);
        receipts[name] = json(`${receiptRoot}/${name}`, workspace, 4096);
    }
    assert.equal(hash(bytes(robotFile, robotRoot)), hash(robotBytes), 'Owned robot registration changed during capture.');
    assert.deepEqual(await readLiveSkillsCodeHashes({ expectedRepository, contractFiles }, { codeRoot, fsApi }), codeHashes, 'Copilot source changed during composition.');
    for (const file of Object.keys(expectedAla.hashes)) assert.equal(hash(bytes(`${expectedAla.root}/${file}`, expectedAla.root)), expectedAla.hashes[file], 'ALA source changed during composition.');
    emit({ workspaceRoot, robotRoot, robot: { id: robotId, name: robotName, repository: { name: registered[0].name, source: registered[0].source, generation: registered[0].generation } },
        session: { sessionId: session.sessionId, cwd: session.cwd, engine: session.engine,
            skillPolicyRef: session.skillPolicyRef, skillExecution: session.skillExecution, presentations,
            messages: session.messages.filter(message => ['user', 'assistant'].includes(message.role))
                .map(({ id, role, text, status, turnId }) => ({ id, role, text, status, turnId })) },
        native, catalog, capturedFiles, liveLinks, receipts, codeHashes, alaBinding: expectedAla, capturedAt: new Date().toISOString() });
}

const RUNTIME_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STAGED_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SUBJECT = 'Live skills runtime';

// The RoboTeam runtime is a managed, global Podman agent. Ploinky's production mount builder
// (cli/sandbox/docker/agentServiceManager.js) gives it these binds, and only these may overlap a path the
// evidence reads. Everything else a runtime mounts (/shared, the probe control root, the edge topology,
// /root, dependency trees, linked repositories) lies outside those paths and is not part of the proof.
//   - the project bind: the workspace root at its own path, writable (buildPersistentAgentRunArgs, homeLayout.binds)
//   - the persistent storage `.data/roboTeamAgent` at /data (manifest volume)
//   - the staged agent source at its own path (buildPodmanStagedTargetMounts: setPodmanTargetMount(agentCodePath))
//   - /code and /Agent from `<root>/.ploinky/container-runtime/<key>/` (ensurePodmanStagedCodeDir, StagedAgentLibDir)
//   - the read-only AgentLib grant: Source and Destination are both /opt/ploinky-agentlib (agentLibGrant)
//   - the read-only self pin of the controller root `<root>/.ploinky` (controllerGuardMounts.pinAncestors). Production
//     emits it for every runtime that has the root project bind; it needs allow-listing only when the verified
//     source lives below it, because only then does it overlap a path the evidence reads.
// /Agent and the AgentLib grant are always emitted exactly once, read-only, so both are required.
export function validateLiveSkillsRuntimeBinding(runtime, expectedRepository, { workspaceRoot, fixtureWorkspace = null, fixtureRepository = null, alaSource = null, fsApi = null } = {}) {
    const root = assertBoxWorkspacePath(workspaceRoot);
    assert.match(runtime.containerId, /^[0-9a-f]{64}$/);
    assert.match(runtime.instanceId, UUID);
    assert.match(runtime.enableGeneration, UUID);
    assert.ok(Number.isFinite(Date.parse(runtime.startedAt)));
    assert.match(runtime.imageId, /^sha256:[0-9a-f]{64}$|^[0-9a-f]{64}$/);
    assert.match(String(runtime.key), RUNTIME_KEY, 'The runtime registry key is not a single path segment.');
    assert.ok(typeof expectedRepository === 'string' && expectedRepository.startsWith(`${root}/`)
        && path.posix.normalize(expectedRepository) === expectedRepository, 'The verified AchillesCLI repository is outside the admitted root.');
    assert.ok(Array.isArray(runtime.mounts), 'The runtime must report its exact mount inventory.');
    const options = { fsApi: fsApi || undefined, lexical: true, subject: SUBJECT };
    const writable = (destination, source) => {
        const mount = requireMount(runtime.mounts, destination, source, options);
        assert.equal(mount.RW, true, `Runtime needs a writable ${destination} mount.`);
        return mount;
    };
    const staged = (destination, prefix) => {
        const selected = runtime.mounts.filter(item => item.Destination === destination);
        assert.equal(selected.length, 1, `Runtime needs one exact ${destination} mount.`);
        const [mount] = selected;
        assert.ok(typeof mount.Source === 'string' && mount.Source.startsWith(prefix) && STAGED_DIRECTORY.test(mount.Source.slice(prefix.length)),
            `Runtime ${destination} is not one staged directory of its own runtime key.`);
        return requireMount(runtime.mounts, destination, mount.Source, options);
    };
    const sourceRoot = `${expectedRepository}/roboTeamAgent`;
    const stagingRoot = `${root}/.ploinky/container-runtime/${runtime.key}/`;
    const allowed = [
        writable(root, root),
        writable('/data', `${root}/.data/roboTeamAgent`),
        writable(sourceRoot, sourceRoot),
        staged('/code', `${stagingRoot}code-`),
    ];
    const protectedPaths = ['/data', '/code', '/Agent', '/opt/ploinky-agentlib', sourceRoot];
    const agent = staged('/Agent', `${stagingRoot}Agent-`);
    assert.equal(agent.RW, false, 'Runtime /Agent must be read-only.');
    allowed.push(agent);
    // The AgentLib source lives in the Box namespace, so only its mount tuple is checked, never a host realpath.
    allowed.push(requireMount(runtime.mounts, '/opt/ploinky-agentlib', '/opt/ploinky-agentlib', { readOnly: true, lexical: true, subject: SUBJECT }));
    // The controller root is pinned read-only by a self bind when the verified source lives below it.
    const pin = `${root}/.ploinky`;
    if (inside(pin, sourceRoot) && runtime.mounts.some(item => item.Destination === pin)) {
        allowed.push(requireMount(runtime.mounts, pin, pin, { ...options, readOnly: true }));
    }
    if (fixtureWorkspace !== null) {
        assert.equal(fixtureWorkspace, liveSkillsWorkspace(root, path.posix.basename(fixtureWorkspace)), 'The run folder is not under the admitted root.');
        protectedPaths.push(fixtureWorkspace);
    }
    if (alaSource !== null) {
        assert.ok(alaSource.startsWith(`${root}/`) && path.posix.normalize(alaSource) === alaSource);
        protectedPaths.push(alaSource);
        // Ploinky link-install uses a canonical same-path source grant, writable for this global agent.
        if (runtime.mounts.some(mount => mount.Destination === alaSource)) allowed.push(requireMount(runtime.mounts, alaSource, alaSource, options));
    }
    if (fixtureRepository !== null) {
        assert.ok(fixtureRepository.startsWith(`${root}/copilot-live-source-`) && path.posix.dirname(fixtureRepository) === root);
        protectedPaths.push(fixtureRepository);
    }
    rejectShadows(runtime.mounts, protectedPaths, allowed, { subject: SUBJECT });
    return runtime;
}

// Box-side sources the validated runtime binds from. The inner validator resolves them on the host, which only proves
// something when the Box sees the same directory there, so no outer mount may overlap any of them.
export function liveSkillsProtectedSources(runtime, expectedRepository, workspaceRoot) {
    const root = assertBoxWorkspacePath(workspaceRoot);
    const sourceRoot = `${expectedRepository}/roboTeamAgent`;
    const sources = [sourceRoot];
    for (const destination of ['/data', '/code', '/Agent']) {
        for (const mount of runtime.mounts.filter(item => item.Destination === destination)) sources.push(mount.Source);
    }
    const pin = `${root}/.ploinky`;
    if (inside(pin, sourceRoot) && runtime.mounts.some(item => item.Destination === pin)) sources.push(pin);
    return sources;
}

// After the runtime is validated: only the exact root bind (and, in local-AgentLib mode, its exact read-only
// same-path alias) may overlap those sources, an ancestor of the root, or the run folder.
function rejectOuterRuntimeShadows(outer, hostWorkspace, protectedSources, agentLibAlias) {
    const allowed = outer.Mounts.filter(item => item.Destination === hostWorkspace);
    if (agentLibAlias && outer.Mounts.some(item => item.Destination === agentLibAlias)) {
        allowed.push(requireMount(outer.Mounts, agentLibAlias, agentLibAlias, { readOnly: true, lexical: true, subject: SUBJECT }));
    }
    rejectShadows(outer.Mounts, protectedSources, allowed, { subject: SUBJECT });
}

// The Box mounts the workspace at its own host path. Besides the exact same-path root, no outer mount may
// overlap the verified RoboTeam source or any of its ancestors.
function validateOuterWorkspaceBinding(outer, hostWorkspace, repositorySource, realpathSync) {
    const root = assertBoxWorkspacePath(hostWorkspace);
    // Exact root proof: the Box's own PLOINKY_WORKSPACE_ROOT, cwd and one writable same-path bind.
    assert.equal(inspectBoxWorkspace(outer).source, root, 'The live Box runs another workspace than the selected host workspace.');
    validateWorkspaceSourceMount(outer.Mounts, root, { realpathSync });
    rejectShadows(outer.Mounts, [`${repositorySource}/roboTeamAgent`], outer.Mounts.filter(item => item.Destination === root), { subject: SUBJECT });
}

export async function createLiveSkillsRuntimeReader({ env = process.env, baseURL, verifierPath }, {
    collectRelease = collectCopilotReleaseEvidence, runCommand = command, fsApi = fs,
} = {}) {
    assert.ok(env.SMOKE_PLOINKY_BOX_CONTAINER, 'Set the exact SMOKE_PLOINKY_BOX_CONTAINER name.');
    assert.ok(env.SMOKE_BOX_BASE_URL, 'Set SMOKE_BOX_BASE_URL to the selected host Box loopback origin.');
    assert.ok(env.SMOKE_WORKSPACE_ROOT && path.isAbsolute(env.SMOKE_WORKSPACE_ROOT), 'Set an absolute SMOKE_WORKSPACE_ROOT on the selected host.');
    const hostWorkspace = assertBoxWorkspacePath(fsApi.realpathSync(env.SMOKE_WORKSPACE_ROOT));
    const collect = () => collectRelease({ manifestPath: env.SMOKE_RELEASE_MANIFEST,
        verifierPath, baseURL, boxBaseURL: env.SMOKE_BOX_BASE_URL,
        expectedContainerName: env.SMOKE_PLOINKY_BOX_CONTAINER, expectedImageRef: env.SMOKE_EXPECT_BOX_IMAGE_REF,
        generationMaxAgeMs: env.SMOKE_BOX_MAX_GENERATION_AGE_MS });
    const release = await collect();
    const box = release.liveBox.box;
    assert.match(box.containerId, /^[0-9a-f]{64}$/);
    assert.equal(release.liveBox.workspaceSourceMount?.source, hostWorkspace, 'The verified Box workspace is not the selected host workspace.');
    // The Box mounts the workspace at its own path, so the verified host repository is also its runtime path.
    const hostRepository = fsApi.realpathSync(release.repositories.achillesCLI.repositoryPath);
    assert.ok(hostRepository.startsWith(`${hostWorkspace}/`) && path.posix.normalize(hostRepository) === hostRepository,
        'Verified AchillesCLI must belong to the selected workspace.');
    const expectedRepository = hostRepository;
    assert.ok(env.SMOKE_ALA_COMMAND && path.isAbsolute(env.SMOKE_ALA_COMMAND), 'Set SMOKE_ALA_COMMAND to the exact selected deployed ALA bin/ala.mjs.');
    const alaCommand = fsApi.realpathSync(env.SMOKE_ALA_COMMAND);
    const alaRoot = path.posix.dirname(path.posix.dirname(alaCommand));
    assert.equal(alaCommand, `${alaRoot}/bin/ala.mjs`);
    assert.ok(alaRoot.startsWith(`${hostWorkspace}/`), 'Selected ALA must belong to the admitted workspace.');
    assert.equal(JSON.parse(fsApi.readFileSync(`${alaRoot}/package.json`, 'utf8')).name, 'advanced-language-agent');
    const expectedAla = { command: alaCommand, root: alaRoot, hashes: Object.fromEntries(['package.json', 'bin/ala.mjs', 'src/transcript.mjs']
        .map(file => [file, liveSkillsHash(fsApi.readFileSync(`${alaRoot}/${file}`))])) };
    // A local or managed AgentLib is shadowed read-only at its own path below the root; an image AgentLib has no alias.
    const libRelative = release.agentLib?.mode && release.agentLib.mode !== 'image' ? release.agentLib.sourceRelativePath : null;
    const agentLibAlias = typeof libRelative === 'string' && libRelative !== 'image' ? path.posix.join(hostWorkspace, libRelative) : null;
    assert.ok(agentLibAlias === null || (agentLibAlias.startsWith(`${hostWorkspace}/`) && path.posix.normalize(agentLibAlias) === agentLibAlias),
        'The AgentLib source must lie inside the admitted root.');
    const codeHashes = Object.fromEntries(CONTRACT_FILES.map(file => [file, liveSkillsHash(fsApi.readFileSync(path.join(hostRepository, 'roboTeamAgent', file)))]));
    let initialRuntime;
    async function binding(fixtureWorkspace = null, fixtureRepository = null) {
        const [outer] = await runCommand(['inspect', box.containerId]);
        assert.equal(outer.Id, box.containerId);
        assert.equal(outer.State.Running, true);
        assert.equal(new Date(outer.State.StartedAt).toISOString(), new Date(box.startedAt).toISOString());
        assert.equal(normalizeLiveSkillsImageId(outer.Image), normalizeLiveSkillsImageId(box.imageId));
        validateOuterWorkspaceBinding(outer, hostWorkspace, expectedRepository, fsApi.realpathSync);
        const runtime = validateLiveSkillsRuntimeBinding(await runCommand(['exec', '-i', '--user', 'podman', box.containerId,
            'node', '--input-type=module', '-'], program(readRegistryAndRuntime, { workspaceRoot: hostWorkspace })), expectedRepository,
        { workspaceRoot: hostWorkspace, fixtureWorkspace, fixtureRepository, alaSource: alaRoot, fsApi });
        rejectOuterRuntimeShadows(outer, hostWorkspace, [...liveSkillsProtectedSources(runtime, expectedRepository, hostWorkspace), alaRoot,
            ...(fixtureWorkspace ? [fixtureWorkspace] : []), ...(fixtureRepository ? [fixtureRepository] : [])], agentLibAlias);
        if (initialRuntime) assert.deepEqual(runtime, initialRuntime, 'RoboTeam runtime was replaced, restarted or remounted during the test.');
        else initialRuntime = runtime;
        return runtime;
    }
    await binding();
    return {
        release,
        workspaceRoot: hostWorkspace,
        async fixtureOperation(action, fixture) {
            assert.ok(['prepare', 'seed-defaults', 'remove-links', 'remove-folders'].includes(action));
            assert.equal(fixture.workspace, liveSkillsWorkspace(hostWorkspace, fixture.folder));
            const runtime = await binding(fixture.workspace, fixture.repositoryRoot);
            return runCommand(['exec', '-i', '--user', 'podman', box.containerId, 'podman', 'exec', '-i', runtime.containerId,
                'node', '--input-type=module', '-'], program(operateLiveSkillsFixture, {
                action, fixture, workspaceRoot: hostWorkspace, expectedRepository, contractHashes: codeHashes,
            }));
        },
        async capture({ sessionId, fixture }) {
            assert.equal(fixture.workspace, liveSkillsWorkspace(hostWorkspace, fixture.folder), 'The fixture is not under the admitted workspace root.');
            assert.match(fixture.robotId || '', /^[a-z0-9][a-z0-9-]{2,63}$/, 'An explicit owned robot ID is required.');
            assert.equal(fixture.repositoryRoot, `${hostWorkspace}/${fixture.repositoryName}`);
            const runtime = await binding(fixture.workspace, fixture.repositoryRoot);
            const snapshot = await runCommand(['exec', '-i', '--user', 'podman', box.containerId, 'podman', 'exec', '-i', runtime.containerId,
                'node', '--input-type=module', '-'], program(readLiveSkillsSnapshot, {
                sessionId, folder: fixture.folder, skillNames: [fixture.control.name, fixture.probe.name, fixture.added.name], contractFiles: CONTRACT_FILES,
                expectedRepository, workspaceRoot: hostWorkspace, robotId: fixture.robotId, robotName: fixture.robotName,
                repositoryName: fixture.repositoryName, repositoryRoot: fixture.repositoryRoot, expectedAla,
            }));
            assert.equal(snapshot.workspaceRoot, hostWorkspace, 'The runtime capture used a different workspace root.');
            assert.deepEqual(snapshot.codeHashes, codeHashes, 'Running Copilot source differs from the verified checkout.');
            assert.deepEqual(snapshot.alaBinding, expectedAla, 'Runtime ALA evidence does not match selected source.');
            return snapshot;
        },
        async finish() {
            await binding();
            const after = await collect();
            assert.ok(sameCopilotReleaseGeneration(release, after), 'The release/Box generation changed during the live skill mutations.');
            return { release: after, runtime: initialRuntime, contractHashes: codeHashes, alaBinding: expectedAla };
        },
    };
}
