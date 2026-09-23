#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { productionAdapters, QA_SCOPE } from './rollback-explorer-qa.mjs';

export const EXPLORER_SOURCE = '.ploinky/repos/AchillesIDE';
const COMMIT = /^[a-f0-9]{40}$/;
const ID = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SOURCE_ORIGIN = /^https:\/\/github\.com\/AssistOS-AI\/AssistOSExplorer(?:\.git)?$/i;
// In this reviewed lifecycle implementation the selector rejection precedes
// control-socket retirement, signals, and all container mutations.
const PRE_SIGNAL_LIFECYCLE_SHA256 = '267a0cd6eec97568bf5f72eaee0c52243a2a96b7a19c198732f466f0db3909cf';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const present = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const safeFailureCode = (error, fallback) => /^(?:QA_|PLOINKY_BOX_)[A-Z_]+$/.test(error?.code || '') ? error.code : fallback;

export function freshLoopbackHttpGet(options, callback) {
    // Synchronous identity probes can outlive the Router's keep-alive timeout
    // while Node has not yet processed its pooled socket's close event.
    return http.get({ ...options, agent: false }, callback);
}

function prove(condition, code) {
    if (!condition) throw Object.assign(new Error(code), { code });
}

function directory(file) {
    const stat = fs.lstatSync(file);
    prove(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(file) === file, 'QA_UPDATE_DIRECTORY_INVALID');
    return { device: String(stat.dev), inode: String(stat.ino) };
}

function readJson(file) {
    const stat = fs.lstatSync(file);
    prove(stat.isFile() && !stat.isSymbolicLink(), 'QA_UPDATE_STATE_FILE_INVALID');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sourcePaths(scope) {
    const relatives = ['.runtime/ploinky', 'AdvancedLanguageAgent', 'achillesAgentLib'];
    for (const relative of ['.ploinky/repos', '.ploinky/agentlib/generations']) {
        const container = path.join(scope.workspace, relative);
        if (present(container)) {
            directory(container);
            relatives.push(...fs.readdirSync(container).sort().map(name => path.join(relative, name)));
        }
    }
    return relatives.filter(relative => present(path.join(scope.workspace, relative))).sort();
}

function publicationIntent(scope) {
    const file = path.join(scope.workspace, '.ploinky/edge-desired.json');
    const desired = readJson(file);
    prove(Object.keys(desired.hosts || {}).join(',') === 'explorer-qa.axiologic.dev'
        && desired.hosts['explorer-qa.axiologic.dev'].agent === 'AchillesIDE/explorer'
        && desired.media?.publicIPv4 === '45.136.70.141' && desired.media.addressMode === 'direct'
        && /^[a-f0-9-]{36}$/.test(desired.cloudflare?.tunnelId || '')
        && desired.cloudflare.tunnelId !== '091c4096-d1c8-4dbc-bb12-0c6357431d96'
        && desired.cloudflare.tunnelTokenSecret === 'publication/explorer-qa-tunnel'
        && desired.cloudflare.apiTokenSecret === 'publication/explorer-qa-api', 'QA_UPDATE_PUBLICATION_NOT_QA');
    return digest(fs.readFileSync(file));
}

/** Reject changes that need installation, migration, image or graph reconciliation. */
export function classifyChanges(changes, agentRoots) {
    const agents = new Set(agentRoots);
    const affected = new Set();
    const browserPaths = [];
    let shared = false;
    for (const change of changes) {
        const file = change.path;
        prove(typeof file === 'string' && file && !file.startsWith('/') && !file.includes('\\')
            && !file.split('/').some(part => !part || part === '.' || part === '..'), 'QA_UPDATE_CHANGE_PATH_INVALID');
        prove(['000000', '100644', '100755'].includes(change.oldMode)
            && ['000000', '100644', '100755'].includes(change.newMode)
            && (change.oldMode === '000000' || change.newMode === '000000' || change.oldMode === change.newMode),
        'QA_UPDATE_FILE_TYPE_CHANGED');
        const parts = file.split('/'), root = parts[0], name = parts.at(-1);
        // These trees do not execute in an existing deployment.
        if (['docs', 'tests', '.github', '.agents'].includes(root)
            || (parts.length === 1 && /\.(?:md|html|txt)$/i.test(name))
            || (agents.has(root) && ['docs', 'tests'].includes(parts[1]))) continue;
        prove(!/(?:^|\/)(?:manifest\.json|package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Dockerfile(?:\.[^/]*)?|docker-compose[^/]*|compose\.ya?ml|dependencies[^/]*|requirements[^/]*|\.gitmodules|\.gitattributes|\.npmrc)$/i.test(file)
            && !parts.some(part => /^(?:hooks|scripts|install|preinstall|postinstall|uninstall|migrations|vendor|node_modules)$/i.test(part))
            && !/^(?:pre|post)?(?:install|uninstall|start|stop|build)(?:[.-]|$)/i.test(name),
        'QA_UPDATE_REQUIRES_RECONFIGURATION');
        prove(/\.(?:[cm]?js|css|html|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i.test(name),
            'QA_UPDATE_REQUIRES_RECONFIGURATION');
        if (root === 'shared') shared = true;
        else {
            prove(agents.has(root), 'QA_UPDATE_UNKNOWN_RUNTIME_PATH');
            // These reviewed trees are browser modules/assets streamed directly
            // from the route's live hostPath by the Ploinky static handler.
            const browser = /^(?:explorer|gitAgent|webmeetAgent)\/IDE-plugins\//.test(file)
                || /^explorer\/(?:web-components\/|shared\/(?:ui|assets)\/|assets\/icons\/)/.test(file)
                || file === 'explorer/services/infrastructure/explorerApi.js';
            if (browser) browserPaths.push({ path: file, deleted: change.newMode === '000000' });
            else affected.add(root);
        }
    }
    return { affected: [...affected].sort(), shared, browserPaths };
}

function selection(agent) {
    const { name, repo, agent: agentName, alias, profile, auth, runMode, develRepo, instanceId, enableGeneration } = agent;
    prove(NAME.test(name) && NAME.test(repo) && NAME.test(agentName) && (!alias || NAME.test(alias))
        && typeof profile === 'string' && profile && ['none', 'local', 'sso', 'guest'].includes(auth)
        && ['isolated', 'global', 'devel'].includes(runMode)
        && typeof instanceId === 'string' && instanceId && typeof enableGeneration === 'string' && enableGeneration,
    'QA_UPDATE_AGENT_SELECTION_INVALID');
    return { name, repo, agent: agentName, alias, profile, auth, runMode,
        ...(runMode === 'devel' ? { develRepo } : {}), instanceId, enableGeneration };
}

/** Recover only a predecessor that never stopped or changed physical identity. */
export async function recoverUnchangedAgentRoute(expected, adapters) {
    const requireEvidence = condition => {
        if (!condition) throw Object.assign(new Error('QA_UPDATE_UNCHANGED_ROUTE_RECOVERY_REJECTED'),
            { code: 'QA_UPDATE_UNCHANGED_ROUTE_RECOVERY_REJECTED', operation: 'recover-unchanged-agent-route' });
    };
    const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
    requireEvidence(expected.predecessorUntouched === expected.name
        && expected.repo === 'AchillesIDE' && expected.routeKey === (expected.alias || expected.agent)
        && expected.route?.container === expected.name && expected.route.repo === expected.repo
        && expected.route.agent === expected.agent && expected.route.hostPath === expected.hostPath
        && expected.route.draining !== true && expected.route.disabled !== true
        && Number.isSafeInteger(expected.route.hostPort) && expected.route.hostPort > 0 && expected.route.hostPort <= 65535);
    const validate = () => {
        const active = adapters.readActive(), routing = adapters.readRouting(), registry = adapters.readRegistry();
        const record = registry[expected.name], container = adapters.inspectContainer(expected.id);
        requireEvidence(active?.selector?.state === 'active' && active.selector.publicationState === 'ready'
            && record?.repoName === expected.repo && record.agentName === expected.agent
            && record.containerId === expected.id && record.instanceId === expected.instanceId
            && record.enableGeneration === expected.enableGeneration && (record.alias || '') === expected.alias
            && (record.profile || 'default') === expected.profile && record.auth?.mode === expected.auth
            && (record.runMode || 'isolated') === expected.runMode
            && container?.Id === expected.id && container.State?.Running === true && container.Image === expected.image);
        const current = active.generation?.routing?.routes?.[expected.routeKey];
        const original = canonical(expected.route), drained = canonical({ ...expected.route, draining: true });
        requireEvidence(canonical(current) === canonical(routing.routes?.[expected.routeKey])
            && [original, drained].includes(canonical(current)));
        return canonical(current) === original;
    };
    return adapters.withWorkspaceLease({ operation: 'recover-unchanged-agent-route' }, () =>
        adapters.withMaintenance(expected.name, { operation: 'recover-route' }, () =>
            adapters.withNetwork(async capability => {
                if (validate()) return { result: 'unchanged', containerId: expected.id };
                await adapters.mergeRouting(routing => {
                    if (Object.hasOwn(expected.route, 'draining')) routing.routes[expected.routeKey].draining = expected.route.draining;
                    else delete routing.routes[expected.routeKey].draining;
                    return routing;
                }, { reason: 'recover-unchanged-agent-after-failed-drain', networkLifecycleCapability: capability,
                    validateActiveGeneration: validate });
                requireEvidence(validate());
                return { result: 'restored', containerId: expected.id };
            })));
}

/** The service has no Box lifecycle, data-copy, dependency-install, or cache-removal adapter. */
export function createUpdateService(adapters, scope = QA_SCOPE) {
    const repository = path.join(scope.workspace, EXPLORER_SOURCE);
    const pins = () => sourcePaths(scope).map(relative => ({ relative,
        directory: directory(path.join(scope.workspace, relative)), ...adapters.sourcePin(path.join(scope.workspace, relative)) }));

    async function snapshot() {
        adapters.assertHost();
        const workspaceIdentity = directory(scope.workspace);
        const boxes = adapters.boxes();
        prove(boxes.length === 1 && boxes[0].box.name === scope.box && boxes[0].box.running, 'QA_UPDATE_EXACT_RUNNING_BOX_REQUIRED');
        const current = boxes[0];
        const sources = pins();
        prove(sources.some(source => source.relative === '.runtime/ploinky')
            && sources.some(source => source.relative === EXPLORER_SOURCE), 'QA_UPDATE_SOURCES_INCOMPLETE');
        const dependencyLock = readJson(path.join(scope.workspace, '.runtime/ploinky/ploinky-box/dependencies.lock.json'));
        const locked = dependencyLock.repositories?.achillesAgentLib;
        prove(locked?.url === 'https://github.com/AssistOS-AI/AchillesAgentLib.git' && COMMIT.test(locked.commit), 'QA_UPDATE_AGENTLIB_LOCK_INVALID');
        const agentLib = await adapters.verifyAgentLib(current, locked.commit);
        for (const destination of ['/opt/ploinky', ...(agentLib.mode === 'image' ? [] : ['/opt/ploinky-agentlib'])]) {
            const mounts = current.box.mounts.filter(mount => mount.Destination === destination);
            prove(mounts.length === 1 && sources.some(source => path.join(scope.workspace, source.relative) === mounts[0].Source),
                'QA_UPDATE_MOUNTED_SOURCE_NOT_CAPTURED');
        }
        const runtime = await adapters.runtime(current);
        prove(Array.isArray(runtime.agents) && runtime.agents.length > 0, 'QA_UPDATE_AGENT_SELECTION_INVALID');
        const agents = [...runtime.agents].sort((a, b) => a.name.localeCompare(b.name));
        for (const agent of agents) selection(agent);
        prove(new Set(agents.map(agent => agent.name)).size === agents.length
            && agents.some(agent => agent.repo === 'AchillesIDE' && agent.agent === 'explorer'), 'QA_UPDATE_AGENT_SELECTION_INVALID');
        return { machineId: adapters.machineId(), workspaceIdentity, current, sources, agentLib,
            desiredDigest: publicationIntent(scope), runtime: { ...runtime, agents } };
    }

    function source(snapshotValue) {
        return snapshotValue.sources.find(item => item.relative === EXPLORER_SOURCE);
    }

    function assertReady(value) {
        prove(value.runtime.active === true && value.runtime.agents.every(agent => agent.ready === true
            && ID.test(agent.id || '') && ID.test(String(agent.image || '').replace(/^sha256:/, ''))), 'QA_UPDATE_RUNTIME_NOT_READY');
    }

    function assertRetained(value, authority, commit, touched = [], recovering = false) {
        prove(value.machineId === authority.machineId && equal(value.workspaceIdentity, authority.workspaceIdentity)
            && value.current.engine === authority.current.engine && value.current.box.id === authority.current.box.id
            && value.current.box.contract === authority.current.box.contract
            && equal(value.agentLib, authority.agentLib) && value.desiredDigest === authority.desiredDigest,
        'QA_UPDATE_RUNTIME_IDENTITY_CHANGED');
        const expected = authority.sources.map(item => item.relative === EXPLORER_SOURCE ? { ...item, commit } : item);
        prove(equal(value.sources, expected), 'QA_UPDATE_SOURCE_IDENTITY_CHANGED');
        prove(equal(value.runtime.agents.map(selection), authority.runtime.agents.map(selection)), 'QA_UPDATE_SELECTION_CHANGED');
        for (const prior of authority.runtime.agents) {
            const current = value.runtime.agents.find(agent => agent.name === prior.name);
            prove(current.hostPath === prior.hostPath, 'QA_UPDATE_STATIC_SOURCE_CHANGED');
            if (!touched.includes(prior.name)) prove(current.id === prior.id && current.image === prior.image,
                'QA_UPDATE_UNRELATED_AGENT_CHANGED');
            else prove(current.image === prior.image || (recovering && current.image === null), 'QA_UPDATE_AGENT_IMAGE_CHANGED');
        }
        if (touched.length === 0) prove(value.runtime.generation === authority.runtime.generation
            && value.runtime.activationId === authority.runtime.activationId, 'QA_UPDATE_ROUTING_CHANGED');
    }

    function affectedAgents(value, classified) {
        const affected = value.runtime.agents.filter(agent => agent.repo === 'AchillesIDE'
            && (classified.shared || classified.affected.includes(agent.agent)));
        for (const agent of affected) {
            prove(agent.runMode !== 'devel' && !agent.alias
                && value.runtime.agents.filter(row => row.repo === agent.repo && row.agent === agent.agent).length === 1,
            'QA_UPDATE_TARGET_NOT_UNAMBIGUOUS');
        }
        return affected;
    }

    async function candidate(value, requireLocal = false) {
        const prior = source(value);
        prove(SOURCE_ORIGIN.test(prior.origin), 'QA_UPDATE_DEFAULT_BRANCH_REQUIRED');
        const remote = adapters.remoteDefault(repository);
        prove(COMMIT.test(remote.commit)
            && prior.branch === remote.branch && prior.branch !== 'HEAD', 'QA_UPDATE_DEFAULT_BRANCH_REQUIRED');
        prove(adapters.upstream(repository) === `origin/${remote.branch}`, 'QA_UPDATE_DEFAULT_UPSTREAM_REQUIRED');
        const available = adapters.hasCommit(repository, remote.commit);
        prove(!requireLocal || available, 'QA_UPDATE_CANDIDATE_MISSING');
        if (!available) return { ...remote, changedPaths: null, affected: null, local: false };
        prove(adapters.isAncestor(repository, prior.commit, remote.commit), 'QA_UPDATE_NOT_FAST_FORWARD');
        const changes = adapters.changes(repository, prior.commit, remote.commit);
        const classified = classifyChanges(changes, adapters.agentRoots(repository, prior.commit));
        const browserAgents = [...new Set(classified.browserPaths.map(file => file.path.split('/')[0]))].sort();
        for (const agent of value.runtime.agents.filter(row => row.repo === 'AchillesIDE' && browserAgents.includes(row.agent))) {
            prove(agent.hostPath === path.join(repository, agent.agent), 'QA_UPDATE_STATIC_SOURCE_UNPROVEN');
        }
        return { ...remote, changedPaths: changes.length, affected: affectedAgents(value, classified),
            browserPaths: classified.browserPaths, browserAgents, local: true };
    }

    async function plan() {
        const value = await snapshot();
        assertReady(value);
        await adapters.health(value.current);
        const next = await candidate(value);
        return { result: 'planned', mutations: false, boxId: value.current.box.id, imageId: value.current.box.image,
            previousCommit: source(value).commit, candidateCommit: next.commit, branch: next.branch,
            changeValidation: next.local ? 'passed' : 'requires-fetch', changedPaths: next.changedPaths,
            agents: next.affected?.map(agent => `AchillesIDE/${agent.agent}`) || null,
            browserAgents: next.browserAgents || null, browserPaths: next.browserPaths?.map(file => file.path) || null };
    }

    async function execute(receiptFile) {
        const receiptDirectory = path.dirname(receiptFile);
        prove(path.isAbsolute(receiptFile) && !present(receiptFile)
            && !receiptFile.startsWith(scope.workspace + '/'), 'QA_UPDATE_RECEIPT_PATH_INVALID');
        directory(receiptDirectory);
        const stat = fs.statSync(receiptDirectory);
        prove(stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'QA_UPDATE_RECEIPT_NOT_PRIVATE');
        let lock = await adapters.acquireWorkspaceLock(scope.workspace);
        let authority, next, receipt;
        const touched = [];
        let changed = false;
        const release = () => { lock?.release(); lock = null; };
        const acquire = async () => { prove(!lock, 'QA_UPDATE_LOCK_STATE_INVALID'); lock = await adapters.acquireWorkspaceLock(scope.workspace); };
        const writeReceipt = (initial = false) => {
            fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n', { flag: initial ? 'wx' : 'w', mode: 0o600 });
        };
        const report = () => ({ result: receipt.status === 'updated' || receipt.status === 'unchanged' ? 'passed' : 'failed',
            status: receipt.status, boxId: authority.current.box.id, imageId: authority.current.box.image,
            previousCommit: source(authority).commit, candidateCommit: next.commit, branch: next.branch,
            agents: touched.map(name => authority.runtime.agents.find(agent => agent.name === name))
                .map(agent => `AchillesIDE/${agent.agent}`), rollback: receipt.rollback || null,
            browserAgents: next.browserAgents || [], browserPaths: next.browserPaths?.map(file => file.path) || [],
            browserVerification: receipt.browserVerification || null,
            ...(receipt.code ? { code: receipt.code } : {}),
            ...(receipt.operation ? { operation: receipt.operation } : {}),
            ...(receipt.rollbackCode ? { rollbackCode: receipt.rollbackCode } : {}),
            ...(receipt.rollbackOperation ? { rollbackOperation: receipt.rollbackOperation } : {}) });
        try {
            authority = await snapshot();
            assertReady(authority);
            await adapters.health(authority.current);
            next = await candidate(authority);
            if (source(authority).commit !== next.commit) {
                // Fetch changes only Git objects/remote refs; no working tree, runtime or data mutations.
                adapters.fetch(repository, next.branch, next.commit);
                assertRetained(await snapshot(), authority, source(authority).commit);
                const selected = await candidate(authority, true);
                prove(selected.branch === next.branch && selected.commit === next.commit, 'QA_UPDATE_REMOTE_MOVED');
                next = selected;
            }
            receipt = { version: 1, status: 'admitted', startedAt: new Date().toISOString(), workspace: scope.workspace,
                boxId: authority.current.box.id, imageId: authority.current.box.image,
                previousCommit: source(authority).commit, candidateCommit: next.commit, branch: next.branch,
                sources: authority.sources, agentLib: authority.agentLib, agents: authority.runtime.agents.map(selection), touched };
            writeReceipt(true);
            if (source(authority).commit === next.commit) {
                receipt.status = 'unchanged'; writeReceipt(); return report();
            }
            assertRetained(await snapshot(), authority, source(authority).commit);
            changed = true;
            adapters.fastForward(repository, next.commit);
            assertRetained(await snapshot(), authority, next.commit);
            receipt.status = 'restarting'; writeReceipt();
            for (const agent of next.affected) {
                assertRetained(await snapshot(), authority, next.commit, touched);
                touched.push(agent.name); writeReceipt();
                // The supported targeted CLI obtains the workspace mutation lock itself.
                release();
                try { await adapters.restart(authority.current, agent); }
                finally { await acquire(); }
                const current = await snapshot();
                assertRetained(current, authority, next.commit, touched);
                assertReady(current);
            }
            const final = await snapshot();
            assertRetained(final, authority, next.commit, touched);
            assertReady(final);
            await adapters.health(final.current);
            if (next.browserPaths.length) {
                receipt.browserVerification = await adapters.verifyBrowserFiles(final.current, repository, next.commit,
                    next.browserPaths.filter(file => final.runtime.agents.some(agent => agent.repo === 'AchillesIDE'
                        && agent.agent === file.path.split('/')[0])));
                assertRetained(await snapshot(), authority, next.commit, touched);
            }
            receipt.status = 'updated'; receipt.completedAt = new Date().toISOString(); writeReceipt();
            return report();
        } catch (error) {
            if (!changed || !receipt) throw error;
            receipt.status = 'failed';
            receipt.code = safeFailureCode(error, 'QA_UPDATE_FAILED');
            if (/^[A-Za-z0-9_:/.-]{1,160}$/.test(error.operation || '')) receipt.operation = error.operation;
            try {
                if (!lock) await acquire();
                assertRetained(await snapshot(), authority, next.commit, touched, true);
                // --keep plus exact clean-candidate proof cannot discard user work.
                adapters.restore(repository, source(authority).commit);
                assertRetained(await snapshot(), authority, source(authority).commit, touched, true);
                receipt.rollback = 'source-restored'; writeReceipt();
                for (const name of touched) {
                    const agent = authority.runtime.agents.find(row => row.name === name);
                    const beforeRecovery = await snapshot();
                    assertRetained(beforeRecovery, authority, source(authority).commit, touched, true);
                    const observed = beforeRecovery.runtime.agents.find(row => row.name === name);
                    if (error.predecessorUntouched === name && observed.id === agent.id
                        && observed.image === agent.image && observed.running === true) {
                        await adapters.recoverUnchangedAgent(beforeRecovery.current, { ...agent, predecessorUntouched: name });
                        continue;
                    }
                    release();
                    try { await adapters.restart(authority.current, agent); }
                    finally { await acquire(); }
                }
                const restored = await snapshot();
                assertRetained(restored, authority, source(authority).commit, touched);
                assertReady(restored);
                await adapters.health(restored.current);
                receipt.rollback = 'passed';
            } catch (rollbackError) {
                receipt.rollback = 'failed';
                receipt.rollbackCode = safeFailureCode(rollbackError, 'QA_UPDATE_ROLLBACK_FAILED');
                if (/^[A-Za-z0-9_:/.-]{1,160}$/.test(rollbackError.operation || '')) receipt.rollbackOperation = rollbackError.operation;
            }
            writeReceipt();
            throw Object.assign(new Error(receipt.code), { code: receipt.code, receipt: report() });
        } finally { release(); }
    }
    return { plan, execute };
}

export function preSignalRestartFailure(result, target) {
    if (!NAME.test(target || '') || result.error || result.signal || !Number.isInteger(result.status) || result.status === 0) return false;
    const message = `managed restart failed: affected selectors remain active for targeted drain of '${target}'`;
    // The reviewed core CLI writes its terminal error to stderr; the outer CLI
    // appends this one status trailer. Earlier stdout/log lines are not proof.
    const lines = typeof result.stderr === 'string' ? result.stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [];
    if (lines.at(-1) === `ploinky: In-box restart failed with status ${result.status}`) lines.pop();
    return lines.at(-1) === `❌ Error: Failed to restart container ${target}: ${message}`;
}

function command(executable, args, options = {}) {
    const { operation = 'external-command', preSignalTarget = null, ...spawnOptions } = options;
    const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...spawnOptions });
    if (result.error || result.status !== 0) throw Object.assign(new Error('QA_UPDATE_EXTERNAL_COMMAND_FAILED'),
        { code: 'QA_UPDATE_EXTERNAL_COMMAND_FAILED', operation,
            ...(preSignalRestartFailure(result, preSignalTarget) ? { predecessorUntouched: preSignalTarget } : {}) });
    return result.stdout;
}

export function updateProductionAdapters(scope = QA_SCOPE) {
    const base = productionAdapters(scope);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PLOINKY_|CLOUDFLARE_|GIT_)/.test(key)));
    const git = (repo, args, options = {}) => command('git', ['-c', `safe.directory=${repo}`,
        '-c', 'core.hooksPath=/dev/null', '-C', repo, ...args],
    { env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, operation: `git-${args[0]}`, ...options });
    const gitSucceeds = (repo, args) => {
        const result = spawnSync('git', ['-c', `safe.directory=${repo}`, '-C', repo, ...args],
            { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
        prove(!result.error && [0, 1, 128].includes(result.status), 'QA_UPDATE_GIT_PROBE_FAILED');
        return result.status === 0;
    };
    return {
        assertHost: base.assertHost, machineId: base.machineId, boxes: base.boxes,
        sourcePin: base.sourcePin, verifyAgentLib: base.verifyAgentLib, acquireWorkspaceLock: base.acquireWorkspaceLock,
        remoteDefault(repo) {
            const output = git(repo, ['ls-remote', '--symref', 'origin', 'HEAD']);
            const lines = output.trim().split('\n');
            const refs = lines.map(line => /^ref: refs\/heads\/(.+)\tHEAD$/.exec(line)).filter(Boolean);
            const heads = lines.map(line => /^([a-f0-9]{40})\tHEAD$/.exec(line)).filter(Boolean);
            prove(refs.length === 1 && heads.length === 1, 'QA_UPDATE_REMOTE_DEFAULT_INVALID');
            const branch = refs[0][1];
            git(repo, ['check-ref-format', `refs/heads/${branch}`]);
            return { branch, commit: heads[0][1] };
        },
        upstream: repo => git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).trim(),
        hasCommit: (repo, commit) => gitSucceeds(repo, ['cat-file', '-e', `${commit}^{commit}`]),
        isAncestor: (repo, before, after) => gitSucceeds(repo, ['merge-base', '--is-ancestor', before, after]),
        agentRoots(repo, commit) {
            return git(repo, ['ls-tree', '-r', '--name-only', '-z', commit]).split('\0')
                .filter(file => /^[^/]+\/manifest\.json$/.test(file)).map(file => file.split('/')[0]);
        },
        changes(repo, before, after) {
            const entries = git(repo, ['diff', '--raw', '--no-abbrev', '--no-renames', '-z', before, after, '--']).split('\0');
            const changes = [];
            for (let index = 0; index < entries.length - 1; index += 2) {
                const match = /^:([0-9]{6}) ([0-9]{6}) [a-f0-9]{40} [a-f0-9]{40} [ADM]$/.exec(entries[index]);
                prove(match && typeof entries[index + 1] === 'string', 'QA_UPDATE_DIFF_INVALID');
                changes.push({ oldMode: match[1], newMode: match[2], path: entries[index + 1] });
            }
            return changes;
        },
        fetch(repo, branch, commit) {
            git(repo, ['fetch', '--no-tags', '--no-recurse-submodules', 'origin',
                `refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeout: 120_000 });
            prove(git(repo, ['rev-parse', `refs/remotes/origin/${branch}`]).trim() === commit, 'QA_UPDATE_REMOTE_MOVED');
        },
        fastForward: (repo, commit) => git(repo, ['merge', '--ff-only', '--no-edit', commit]),
        restore: (repo, commit) => git(repo, ['reset', '--keep', commit]),
        async restart(item, agent) {
            prove(agent.repo === 'AchillesIDE' && NAME.test(agent.agent), 'QA_UPDATE_TARGET_INVALID');
            const lifecycle = path.join(scope.workspace, '.runtime/ploinky/cli/sandbox/docker/targetedContainerLifecycle.js');
            const reviewed = present(lifecycle)?.isFile() && digest(fs.readFileSync(lifecycle)) === PRE_SIGNAL_LIFECYCLE_SHA256;
            command(path.join(scope.workspace, '.runtime/ploinky/bin/ploinky'), ['restart', `AchillesIDE/${agent.agent}`],
                { cwd: scope.workspace, timeout: 600_000, operation: `targeted-restart:AchillesIDE/${agent.agent}`,
                    preSignalTarget: reviewed ? agent.name : null,
                    env: { ...env, PLOINKY_WORKSPACE_ROOT: scope.workspace,
                    PLOINKY_BOX_IMAGE: item.box.imageReference, PLOINKY_ROUTER_HOST_PORT: '8097', PLOINKY_MEDIA_HOST_PORT: '7882' } });
        },
        async recoverUnchangedAgent(item, agent) {
            const script = `
                import {spawnSync} from 'node:child_process';
                import {getAgentsRegistry} from '/opt/ploinky/cli/sandbox/docker/containerRegistry.js';
                import {loadActiveEdgeRoutingGeneration} from '/opt/ploinky/cli/sandbox/edgeGeneration.js';
                import {readRoutingConfig,mergeRoutingConfig} from '/opt/ploinky/cli/server/routingFile.js';
                import {withWorkspaceMutationLease,withMaintenanceLock} from '/opt/ploinky/cli/utils/runtime/maintenanceLocks.js';
                import {withNetworkLifecycleLock} from '/opt/ploinky/cli/sandbox/networkLifecycle.js';
                const recover = ${recoverUnchangedAgentRoute.toString()};
                const expected = JSON.parse(process.argv[2]);
                const result = await recover(expected, {
                    readActive:loadActiveEdgeRoutingGeneration,readRouting:readRoutingConfig,readRegistry:getAgentsRegistry,
                    inspectContainer(id) {
                        const probe = spawnSync('podman', ['container','inspect',id], {encoding:'utf8',timeout:10000,maxBuffer:1048576});
                        if (probe.status !== 0) return null;
                        const records = JSON.parse(probe.stdout);
                        return records.length === 1 ? records[0] : null;
                    },
                    withWorkspaceLease:withWorkspaceMutationLease,withMaintenance:withMaintenanceLock,
                    withNetwork:withNetworkLifecycleLock,mergeRouting:mergeRoutingConfig,
                });
                process.stdout.write(JSON.stringify(result));
            `;
            const result = JSON.parse(command(item.engine, ['container', 'exec', '-i', '--user', 'podman', '--workdir', scope.workspace,
                '--env', `PLOINKY_WORKSPACE_ROOT=${scope.workspace}`, '--env', 'PLOINKY_ROUTER_HOST_PORT=8097',
                '--env', 'PLOINKY_MEDIA_HOST_PORT=7882', item.box.id, 'node', '--input-type=module', '-', JSON.stringify(agent)],
            { env, input: script, operation: 'recover-unchanged-agent-route', timeout: 600_000 }));
            prove(['restored', 'unchanged'].includes(result.result) && result.containerId === agent.id,
                'QA_UPDATE_UNCHANGED_ROUTE_RECOVERY_REJECTED');
            return result;
        },
        async verifyBrowserFiles(item, repository, commit, browserPaths) {
            const expected = browserPaths.map(file => ({ ...file,
                sha256: file.deleted ? null : digest(git(repository, ['show', `${commit}:${file.path}`], { encoding: null })) }));
            const script = `
                import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
                import {loadActiveEdgeRoutingGeneration} from '/opt/ploinky/cli/sandbox/edgeGeneration.js';
                import {resolveAgentStaticFile} from '/opt/ploinky/cli/server/static/index.js';
                const expected = JSON.parse(process.argv[2]);
                const repository = process.argv[3];
                const active = loadActiveEdgeRoutingGeneration();
                for (const file of expected) {
                    const [agent, ...parts] = file.path.split('/');
                    const matches = Object.entries(active.generation.routing.routes).filter(([, route]) =>
                        route.repo === 'AchillesIDE' && route.agent === agent && route.disabled !== true && route.draining !== true);
                    if (matches.length !== 1 || matches[0][1].hostPath !== path.join(repository, agent)) throw Error('static source mismatch');
                    const resolved = await resolveAgentStaticFile(matches[0][0], parts.join('/'), {hostPath:matches[0][1].hostPath});
                    if (file.deleted) { if (resolved !== null) throw Error('removed asset remains served'); continue; }
                    if (resolved !== path.join(repository, file.path) || fs.realpathSync(resolved) !== resolved) throw Error('asset path mismatch');
                    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
                    if (sha256 !== file.sha256) throw Error('asset content mismatch');
                }
                process.stdout.write(JSON.stringify({files:expected.length}));
            `;
            const result = JSON.parse(command(item.engine, ['container', 'exec', '-i', '--user', 'podman', '--workdir', scope.workspace,
                '--env', `PLOINKY_WORKSPACE_ROOT=${scope.workspace}`, '--env', 'PLOINKY_ROUTER_HOST_PORT=8097',
                '--env', 'PLOINKY_MEDIA_HOST_PORT=7882', item.box.id, 'node', '--input-type=module', '-', JSON.stringify(expected), repository],
            { env, input: script, operation: 'browser-source-verification', timeout: 120_000 }));
            prove(result.files === expected.length, 'QA_UPDATE_BROWSER_SOURCE_MISMATCH');
            const publicAssets = expected.filter(file => !file.deleted && /^explorer\/shared\/.+\.(?:css|svg|html)$/.test(file.path));
            const publicAsset = publicAssets.find(file => file.path.endsWith('.css')) || publicAssets[0];
            if (publicAsset) {
                try {
                    const url = new URL(`/${publicAsset.path}`, 'https://explorer-qa.axiologic.dev');
                    url.searchParams.set('qa_revision', commit);
                    const response = await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
                    prove(response.status === 200 && digest(Buffer.from(await response.arrayBuffer())) === publicAsset.sha256,
                        'QA_UPDATE_PUBLIC_ASSET_MISMATCH');
                    result.publicAsset = { path: publicAsset.path, sha256: publicAsset.sha256 };
                } catch (error) {
                    throw Object.assign(new Error('QA_UPDATE_PUBLIC_ASSET_MISMATCH'),
                        { code: 'QA_UPDATE_PUBLIC_ASSET_MISMATCH', operation: 'public-browser-asset' });
                }
            }
            return result;
        },
        async health() {
            const { checkBoxHealth } = await import(pathToFileURL(path.join(scope.workspace, '.runtime/ploinky/ploinky-box/supervisor.mjs')).href);
            try {
                await checkBoxHealth(8097, { timeoutMs: 5000, readinessTimeoutMs: 0, httpGet: freshLoopbackHttpGet });
            } catch (error) {
                throw Object.assign(new Error(safeFailureCode(error, 'QA_UPDATE_LOOPBACK_HEALTH_FAILED')),
                    { code: safeFailureCode(error, 'QA_UPDATE_LOOPBACK_HEALTH_FAILED'), operation: 'loopback-health' });
            }
        },
        async runtime(item) {
            const script = `
                import {spawnSync} from 'node:child_process';
                import {getAgentsRegistry} from '/opt/ploinky/cli/sandbox/docker/containerRegistry.js';
                import {collectAgentRuntimeStatesAsync} from '/opt/ploinky/cli/sandbox/agentRuntimeState.js';
                import {applyRuntimeReadinessProjection} from '/opt/ploinky/cli/utils/noWaitReadiness.js';
                import {loadActiveEdgeRoutingGeneration} from '/opt/ploinky/cli/sandbox/edgeGeneration.js';
                const registry = getAgentsRegistry();
                let activeValue = null;
                try { activeValue = loadActiveEdgeRoutingGeneration(); } catch {}
                const states = applyRuntimeReadinessProjection(await collectAgentRuntimeStatesAsync({registry}), registry);
                const entries = Object.entries(registry).filter(([, row]) => row?.type === 'agent');
                if (states.length !== entries.length || states.some(row => !row.enabled)) throw Error('runtime registry mismatch');
                const agents = entries.map(([name, row]) => {
                    if (row.runtime !== 'podman' || !/^[a-f0-9]{64}$/.test(row.containerId || '')) throw Error('unsupported runtime');
                    const result = spawnSync('podman', ['container', 'inspect', row.containerId], {encoding:'utf8',timeout:10000,maxBuffer:1048576});
                    const inspected = result.status === 0 ? JSON.parse(result.stdout) : [];
                    if (inspected.length > 1 || (inspected.length === 1 && inspected[0].Id !== row.containerId)) throw Error('runtime identity mismatch');
                    const state = states.find(value => value.containerName === name);
                    const ready = inspected[0]?.State?.Running === true && state?.state?.running === true
                        && state.state.status === 'running' && (state.state.noWaitState === undefined
                            || (state.state.noWaitState === 'running' && state.state.ready === true));
                    const routes = Object.entries(activeValue?.generation?.routing?.routes || {})
                        .filter(([,route]) => route.container === name && route.repo === row.repoName && route.agent === row.agentName);
                    const roots = [...new Set(routes.map(([,route]) => route.hostPath))];
                    return {name,repo:row.repoName,agent:row.agentName,alias:row.alias||'',profile:row.profile||'default',
                        auth:row.auth?.mode,runMode:row.runMode||'isolated',...(row.runMode==='devel'?{develRepo:row.develRepo}:{}),
                        instanceId:row.instanceId,enableGeneration:row.enableGeneration,id:row.containerId,
                        image:inspected[0]?.Image||null,ready,running:inspected[0]?.State?.Running===true,
                        hostPath:roots.length===1?roots[0]:null,routeKey:routes.length===1?routes[0][0]:null,
                        route:routes.length===1?routes[0][1]:null};
                });
                const active = activeValue?.selector?.state === 'active' && activeValue.selector.publicationState === 'ready';
                process.stdout.write(JSON.stringify({agents,active,generation:activeValue?.selector?.generation||null,
                    activationId:activeValue?.selector?.activationId||null}));
            `;
            return JSON.parse(command(item.engine, ['container', 'exec', '-i', '--user', 'podman', '--workdir', scope.workspace,
                '--env', `PLOINKY_WORKSPACE_ROOT=${scope.workspace}`, '--env', 'PLOINKY_ROUTER_HOST_PORT=8097',
                '--env', 'PLOINKY_MEDIA_HOST_PORT=7882', item.box.id, 'node', '--input-type=module', '-'],
            { env, input: script, operation: 'runtime-readiness-projection', timeout: 120_000 }));
        },
    };
}

export async function main(argv = process.argv.slice(2)) {
    const [mode, ...flags] = argv;
    prove(mode === 'plan' && flags.length === 0
        || mode === 'execute' && flags.length === 3 && flags[0] === '--receipt' && flags[2] === '--lock-held', 'QA_UPDATE_USAGE_INVALID');
    const adapters = updateProductionAdapters();
    adapters.assertHost();
    if (mode === 'execute') {
        const locked = spawnSync('flock', ['-n', '-E', '75', QA_SCOPE.lock, 'true'], { encoding: 'utf8', timeout: 5000 });
        prove(!locked.error && locked.status === 75, 'QA_UPDATE_HOST_LOCK_REQUIRED');
    }
    const service = createUpdateService(adapters);
    process.stdout.write(JSON.stringify(mode === 'plan' ? await service.plan() : await service.execute(flags[1])) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { await main(); }
    catch (error) {
        process.stdout.write(JSON.stringify(error.receipt || { result: 'failed', status: 'rejected',
            code: safeFailureCode(error, 'QA_UPDATE_REJECTED'),
            ...(/^[A-Za-z0-9_:/.-]{1,160}$/.test(error.operation || '') ? { operation: error.operation } : {}) }) + '\n');
        process.exitCode = 1;
    }
}
