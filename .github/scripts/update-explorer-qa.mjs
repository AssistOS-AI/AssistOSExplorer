#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGitSandbox, currentQaBox, productionAdapters, QA_SCOPE } from './rollback-explorer-qa.mjs';

export const EXPLORER_SOURCE = '.ploinky/repos/AchillesIDE';
const COMMIT = /^[a-f0-9]{40}$/;
const ID = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SOURCE_ORIGIN = /^https:\/\/github\.com\/AssistOS-AI\/AssistOSExplorer(?:\.git)?$/i;
// In this reviewed lifecycle implementation the selector rejection precedes
// control-socket retirement, signals, and all container mutations.
const PRE_SIGNAL_LIFECYCLE_SHA256 = '267a0cd6eec97568bf5f72eaee0c52243a2a96b7a19c198732f466f0db3909cf';
const MANIFEST_DIGEST = /^sha256:[a-f0-9]{64}$/;
const pinnedCommit = value => typeof value === 'string' && COMMIT.test(value);
// Only these classification results mean the Explorer change needs a full redeploy.
const REDEPLOY_CLASSIFICATIONS = new Set(['QA_UPDATE_REQUIRES_RECONFIGURATION',
    'QA_UPDATE_UNKNOWN_RUNTIME_PATH', 'QA_UPDATE_FILE_TYPE_CHANGED']);
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

/** Every selected runtime agent is running, ready and image-identified, and the edge generation is active. */
export function assertRuntimeReady(value) {
    prove(value.runtime.active === true && value.runtime.agents.every(agent => agent.ready === true
        && ID.test(agent.id || '') && ID.test(String(agent.image || '').replace(/^sha256:/, ''))), 'QA_UPDATE_RUNTIME_NOT_READY');
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
            const browser = /^(?:explorer|gitAgent)\/IDE-plugins\//.test(file)
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
    // Source checks run in a sandbox made from the exact image of the current QA Box.
    const pins = current => sourcePaths(scope).map(relative => ({ relative,
        directory: directory(path.join(scope.workspace, relative)),
        ...adapters.sourcePin(path.join(scope.workspace, relative), { engine: current.engine, image: current.box.image }) }));

    async function snapshot() {
        adapters.assertHost();
        const workspaceIdentity = directory(scope.workspace);
        let current;
        try { current = currentQaBox(adapters.boxes(), scope); } catch { prove(false, 'QA_UPDATE_EXACT_RUNNING_BOX_REQUIRED'); }
        const sources = pins(current);
        prove(sources.some(source => source.relative === '.runtime/ploinky')
            && sources.some(source => source.relative === EXPLORER_SOURCE), 'QA_UPDATE_SOURCES_INCOMPLETE');
        // The Box image supplies AchillesAgentLib and is its only identity; the
        // adapter admits only that image-owned selection, so Ploinky is the one
        // mounted source.
        const agentLib = await adapters.verifyAgentLib(current);
        const mounts = current.box.mounts.filter(mount => mount.Destination === '/opt/ploinky');
        prove(mounts.length === 1 && sources.some(source => path.join(scope.workspace, source.relative) === mounts[0].Source),
            'QA_UPDATE_MOUNTED_SOURCE_NOT_CAPTURED');
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

    // Git on the Box-writable checkouts runs only in a sandbox made from the
    // exact image of the QA Box being updated.
    const sandboxOf = value => ({ engine: value.current.engine, image: value.current.box.image });

    async function candidate(value, requireLocal = false, expectedCommit = null) {
        const prior = source(value);
        const sandbox = sandboxOf(value);
        prove(SOURCE_ORIGIN.test(prior.origin), 'QA_UPDATE_DEFAULT_BRANCH_REQUIRED');
        const remote = adapters.remoteDefault(repository, sandbox);
        prove(COMMIT.test(remote.commit)
            && prior.branch === remote.branch && prior.branch !== 'HEAD', 'QA_UPDATE_DEFAULT_BRANCH_REQUIRED');
        // A head that moved after the pin proof is refused before it can be classified as the pinned change.
        prove(expectedCommit === null || remote.commit === expectedCommit, 'QA_UPDATE_REMOTE_MOVED');
        prove(adapters.upstream(repository, sandbox) === `origin/${remote.branch}`, 'QA_UPDATE_DEFAULT_UPSTREAM_REQUIRED');
        const available = adapters.hasCommit(repository, remote.commit, sandbox);
        prove(!requireLocal || available, 'QA_UPDATE_CANDIDATE_MISSING');
        if (!available) return { ...remote, changedPaths: null, affected: null, local: false };
        prove(adapters.isAncestor(repository, prior.commit, remote.commit, sandbox), 'QA_UPDATE_NOT_FAST_FORWARD');
        const changes = adapters.changes(repository, prior.commit, remote.commit, sandbox);
        const classified = classifyChanges(changes, adapters.agentRoots(repository, prior.commit, sandbox));
        const browserAgents = [...new Set(classified.browserPaths.map(file => file.path.split('/')[0]))].sort();
        for (const agent of value.runtime.agents.filter(row => row.repo === 'AchillesIDE' && browserAgents.includes(row.agent))) {
            prove(agent.hostPath === path.join(repository, agent.agent), 'QA_UPDATE_STATIC_SOURCE_UNPROVEN');
        }
        return { ...remote, changedPaths: changes.length, affected: affectedAgents(value, classified),
            browserPaths: classified.browserPaths, browserAgents, local: true };
    }

    async function plan() {
        const value = await snapshot();
        assertRuntimeReady(value);
        await adapters.health(value.current);
        const next = await candidate(value);
        return { result: 'planned', mutations: false, boxId: value.current.box.id, imageId: value.current.box.image,
            previousCommit: source(value).commit, candidateCommit: next.commit, branch: next.branch,
            changeValidation: next.local ? 'passed' : 'requires-fetch', changedPaths: next.changedPaths,
            agents: next.affected?.map(agent => `AchillesIDE/${agent.agent}`) || null,
            browserAgents: next.browserAgents || null, browserPaths: next.browserPaths?.map(file => file.path) || null };
    }

    /**
     * Read-only choice between an in-place update and a full redeploy. Drift in
     * the Box image or in any managed source other than Explorer chooses redeploy
     * before anything is fetched; only then is the Explorer change classified.
     * It writes no receipt and never fast-forwards, restarts or restores.
     */
    async function select({ expectedCommit } = {}) {
        prove(pinnedCommit(expectedCommit), 'QA_UPDATE_USAGE_INVALID');
        // Deliberately no runtime readiness or health proof: a running but unhealthy QA can still be redeployed.
        const authority = await snapshot();
        const prior = source(authority);
        const sandbox = sandboxOf(authority);
        prove(adapters.remoteDefault(repository, sandbox)?.commit === expectedCommit, 'QA_UPDATE_REMOTE_MOVED');
        const remoteImage = await adapters.remoteBoxImage();
        const remoteImageId = String(remoteImage?.configDigest || '').replace(/^sha256:/, '');
        prove(typeof remoteImage?.reference === 'string' && remoteImage.reference && ID.test(remoteImageId), 'QA_SELECT_IMAGE_UNRESOLVED');
        const currentImageId = String(authority.current.box.image).replace(/^sha256:/, '');
        const reasons = [];
        if (currentImageId !== remoteImageId) reasons.push({ source: remoteImage.reference, kind: 'image', from: currentImageId, to: remoteImageId });
        // AgentLib generations and achillesAgentLib are image-owned: never queried, never drift.
        for (const item of authority.sources.filter(pin => pin.relative === '.runtime/ploinky'
            || pin.relative === 'AdvancedLanguageAgent'
            || (pin.relative.startsWith('.ploinky/repos/') && pin.relative !== EXPLORER_SOURCE))) {
            const remote = adapters.remoteDefault(path.join(scope.workspace, item.relative), sandbox);
            prove(pinnedCommit(remote?.commit) && typeof remote.branch === 'string' && remote.branch, 'QA_UPDATE_REMOTE_DEFAULT_INVALID');
            if (item.branch !== remote.branch) reasons.push({ source: item.relative, kind: 'branch', from: item.branch, to: remote.branch });
            if (item.commit !== remote.commit) reasons.push({ source: item.relative, kind: 'commit', from: item.commit, to: remote.commit });
        }
        const report = (mode, fetched) => ({ result: 'selected', mode, mutations: fetched ? 'git-objects-only' : false,
            expectedCommit, previousCommit: prior.commit,
            boxImage: { reference: remoteImage.reference, current: currentImageId, remote: remoteImageId }, reasons });
        if (reasons.length) return report('redeploy', false);
        let fetched = false;
        const lock = await adapters.acquireWorkspaceLock(scope.workspace, { workspaceRoot: scope.workspace });
        try {
            try {
                const next = await candidate(authority, false, expectedCommit);
                prove(next.commit === expectedCommit, 'QA_UPDATE_REMOTE_MOVED');
                if (prior.commit !== next.commit) {
                    // Fetch changes only Git objects/remote refs; no working tree, runtime or data mutations.
                    adapters.fetch(repository, next.branch, next.commit, sandbox);
                    fetched = true;
                    assertRetained(await snapshot(), authority, prior.commit);
                    const selected = await candidate(authority, true, expectedCommit);
                    prove(selected.branch === next.branch && selected.commit === next.commit, 'QA_UPDATE_REMOTE_MOVED');
                }
            } catch (error) {
                if (!REDEPLOY_CLASSIFICATIONS.has(error?.code)) throw error;
                reasons.push({ source: EXPLORER_SOURCE, kind: 'explorer-reconfiguration',
                    from: prior.commit, to: expectedCommit, code: error.code });
                return report('redeploy', fetched);
            }
            return report('in-place', fetched);
        } finally { lock.release(); }
    }

    async function execute(receiptFile, { expectedCommit } = {}) {
        prove(pinnedCommit(expectedCommit), 'QA_UPDATE_USAGE_INVALID');
        const receiptDirectory = path.dirname(receiptFile);
        prove(path.isAbsolute(receiptFile) && !present(receiptFile)
            && !receiptFile.startsWith(scope.workspace + '/'), 'QA_UPDATE_RECEIPT_PATH_INVALID');
        directory(receiptDirectory);
        const stat = fs.statSync(receiptDirectory);
        prove(stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'QA_UPDATE_RECEIPT_NOT_PRIVATE');
        const lockOptions = { workspaceRoot: scope.workspace };
        let lock = await adapters.acquireWorkspaceLock(scope.workspace, lockOptions);
        let authority, next, receipt;
        const touched = [];
        let changed = false;
        const release = () => { lock?.release(); lock = null; };
        const acquire = async () => { prove(!lock, 'QA_UPDATE_LOCK_STATE_INVALID'); lock = await adapters.acquireWorkspaceLock(scope.workspace, lockOptions); };
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
            assertRuntimeReady(authority);
            await adapters.health(authority.current);
            next = await candidate(authority, false, expectedCommit);
            // Thrown before the receipt, any fetch or any change, so the catch below rethrows it without recovery.
            prove(next.commit === expectedCommit, 'QA_UPDATE_REMOTE_MOVED');
            if (source(authority).commit !== next.commit) {
                // Fetch changes only Git objects/remote refs; no working tree, runtime or data mutations.
                adapters.fetch(repository, next.branch, next.commit, sandboxOf(authority));
                assertRetained(await snapshot(), authority, source(authority).commit);
                const selected = await candidate(authority, true, expectedCommit);
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
            adapters.fastForward(repository, next.commit, sandboxOf(authority));
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
                assertRuntimeReady(current);
            }
            const final = await snapshot();
            assertRetained(final, authority, next.commit, touched);
            assertRuntimeReady(final);
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
                adapters.restore(repository, source(authority).commit, sandboxOf(authority));
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
                assertRuntimeReady(restored);
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
    return { plan, select, execute };
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

const UNRESOLVED = 'QA_SELECT_IMAGE_UNRESOLVED';
const INDEX_MEDIA_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'];
const MANIFEST_MEDIA_TYPES = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'];
const REGISTRY_TIMEOUT_MS = 15_000;
const REGISTRY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The image ID of a pulled image is its config digest. Resolve the one linux/amd64
 * manifest of a root document (index or single manifest) and return that digest as
 * 64 hex characters. `fetchByDigest(digest)` returns the raw bytes, which must hash
 * to the digest they were requested by. Anything ambiguous or malformed throws.
 */
export async function platformConfigDigest(rootDoc, fetchByDigest, { os = 'linux', architecture = 'amd64' } = {}) {
    const configOf = manifest => {
        prove(manifest && typeof manifest === 'object' && !Array.isArray(manifest) && manifest.schemaVersion === 2
            && !Array.isArray(manifest.manifests) && (manifest.mediaType === undefined || MANIFEST_MEDIA_TYPES.includes(manifest.mediaType))
            && typeof manifest.config?.digest === 'string' && MANIFEST_DIGEST.test(manifest.config.digest), UNRESOLVED);
        return manifest.config.digest.slice('sha256:'.length);
    };
    prove(rootDoc && typeof rootDoc === 'object' && !Array.isArray(rootDoc), UNRESOLVED);
    if (!Array.isArray(rootDoc.manifests)) return configOf(rootDoc);
    prove(rootDoc.schemaVersion === 2 && !rootDoc.config && (rootDoc.mediaType === undefined || INDEX_MEDIA_TYPES.includes(rootDoc.mediaType)), UNRESOLVED);
    // Attestation entries are unknown/unknown and never match a real platform.
    const matches = rootDoc.manifests.filter(entry => entry?.platform?.os === os && entry.platform.architecture === architecture);
    prove(matches.length === 1 && typeof matches[0].digest === 'string' && MANIFEST_DIGEST.test(matches[0].digest), UNRESOLVED);
    const fetched = await fetchByDigest(matches[0].digest);
    const body = typeof fetched === 'string' ? Buffer.from(fetched) : fetched;
    prove(body instanceof Uint8Array && body.length > 0 && body.length <= REGISTRY_MAX_BYTES
        && `sha256:${digest(body)}` === matches[0].digest, UNRESOLVED);
    let child;
    try { child = JSON.parse(Buffer.from(body).toString('utf8')); } catch { prove(false, UNRESOLVED); }
    return configOf(child);
}

const BOX_IMAGE_REFERENCE = /^docker\.io\/([a-z0-9]+(?:[._-][a-z0-9]+)*)\/([a-z0-9]+(?:[._-][a-z0-9]+)*)(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})|@(sha256:[a-f0-9]{64}))$/;

/** Only Docker Hub references of the form docker.io/<namespace>/<repository>:<tag> or ...@sha256:<64 hex>. */
function parseBoxImageReference(reference) {
    const match = typeof reference === 'string' ? BOX_IMAGE_REFERENCE.exec(reference) : null;
    prove(match, 'QA_SELECT_IMAGE_REFERENCE_UNSUPPORTED');
    return { namespace: match[1], repository: match[2], target: match[3] || match[4] };
}

/** The deployed Ploinky checkout names the Box image; the registry says which image that name currently resolves to. */
function boxImageResolver(scope, registryFetch, arch) {
    return async function remoteBoxImage() {
        let reference, parsed;
        try {
            const constants = path.join(scope.workspace, '.runtime/ploinky/ploinky-box/constants.mjs');
            prove(present(constants)?.isFile(), UNRESOLVED);
            const { resolveBoxImageReference } = await import(pathToFileURL(constants).href);
            prove(typeof resolveBoxImageReference === 'function', UNRESOLVED);
            // An empty environment: the QA Box image is never taken from this process's PLOINKY_BOX_IMAGE.
            reference = resolveBoxImageReference({});
            parsed = parseBoxImageReference(reference);
        } catch (error) {
            if (error?.code === 'QA_SELECT_IMAGE_REFERENCE_UNSUPPORTED') throw error;
            throw Object.assign(new Error(UNRESOLVED), { code: UNRESOLVED, operation: 'box-image-reference' });
        }
        try {
            prove(arch === 'x64', UNRESOLVED);
            const repository = `${parsed.namespace}/${parsed.repository}`;
            const get = async (url, headers) => {
                const response = await registryFetch(url, { headers, redirect: 'error', cache: 'no-store',
                    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
                prove(response.status === 200 && !(Number(response.headers?.get?.('content-length')) > REGISTRY_MAX_BYTES), UNRESOLVED);
                const body = Buffer.from(await response.arrayBuffer());
                prove(body.length > 0 && body.length <= REGISTRY_MAX_BYTES, UNRESOLVED);
                return { body, contentDigest: response.headers?.get?.('docker-content-digest') || null };
            };
            const tokenBody = JSON.parse((await get(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
                { Accept: 'application/json' })).body.toString('utf8'));
            const token = tokenBody?.token ?? tokenBody?.access_token;
            prove(typeof token === 'string' && /^[A-Za-z0-9._~+/=-]{1,8192}$/.test(token), UNRESOLVED);
            const headers = { Authorization: `Bearer ${token}`, Accept: [...INDEX_MEDIA_TYPES, ...MANIFEST_MEDIA_TYPES].join(', ') };
            const manifest = async target => {
                const result = await get(`https://registry-1.docker.io/v2/${repository}/manifests/${target}`, headers);
                const actual = `sha256:${digest(result.body)}`;
                // A digest reference and any digest the registry reports must match the bytes received.
                prove((!MANIFEST_DIGEST.test(target) || actual === target) && (!result.contentDigest || actual === result.contentDigest), UNRESOLVED);
                return result.body;
            };
            const root = await manifest(parsed.target);
            let rootDoc;
            try { rootDoc = JSON.parse(root.toString('utf8')); } catch { prove(false, UNRESOLVED); }
            const configDigest = await platformConfigDigest(rootDoc, manifest, { os: 'linux', architecture: 'amd64' });
            return { reference, configDigest };
        } catch {
            // Registry and parse details are never reported.
            throw Object.assign(new Error(UNRESOLVED), { code: UNRESOLVED, operation: 'box-image-resolution' });
        }
    };
}

export function updateProductionAdapters(scope = QA_SCOPE,
    { fetch: registryFetch = (...args) => globalThis.fetch(...args), arch = process.arch } = {}) {
    const base = productionAdapters(scope);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PLOINKY_|CLOUDFLARE_|GIT_)/.test(key)));
    // The Box can write the Explorer checkout and its Git configuration, so Git
    // never runs on it in the host process. Only merge and reset may write it,
    // with fetch, which also needs the network like the remote query.
    const gitSandbox = createGitSandbox({ env });
    const boxGit = (repo, sandbox, args, { write = false, network = false, timeout = 60_000, encoding = 'utf8' } = {}) => {
        const result = gitSandbox(repo, sandbox, args, { write, network, timeout, encoding });
        if (result.error || result.status !== 0) throw Object.assign(new Error('QA_UPDATE_EXTERNAL_COMMAND_FAILED'),
            { code: 'QA_UPDATE_EXTERNAL_COMMAND_FAILED', operation: `git-${args[0]}` });
        return result.stdout;
    };
    const gitSucceeds = (repo, sandbox, args) => {
        const result = gitSandbox(repo, sandbox, args);
        prove(!result.error && [0, 1, 128].includes(result.status), 'QA_UPDATE_GIT_PROBE_FAILED');
        return result.status === 0;
    };
    return {
        assertHost: base.assertHost, machineId: base.machineId, boxes: base.boxes,
        sourcePin: base.sourcePin, verifyAgentLib: base.verifyAgentLib, acquireWorkspaceLock: base.acquireWorkspaceLock,
        remoteBoxImage: boxImageResolver(scope, registryFetch, arch),
        remoteDefault(repo, sandbox) {
            const output = boxGit(repo, sandbox, ['ls-remote', '--symref', 'origin', 'HEAD'], { network: true });
            const lines = output.trim().split('\n');
            const refs = lines.map(line => /^ref: refs\/heads\/(.+)\tHEAD$/.exec(line)).filter(Boolean);
            const heads = lines.map(line => /^([a-f0-9]{40})\tHEAD$/.exec(line)).filter(Boolean);
            prove(refs.length === 1 && heads.length === 1, 'QA_UPDATE_REMOTE_DEFAULT_INVALID');
            const branch = refs[0][1];
            boxGit(repo, sandbox, ['check-ref-format', `refs/heads/${branch}`]);
            return { branch, commit: heads[0][1] };
        },
        upstream: (repo, sandbox) => boxGit(repo, sandbox, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).trim(),
        hasCommit: (repo, commit, sandbox) => gitSucceeds(repo, sandbox, ['cat-file', '-e', `${commit}^{commit}`]),
        isAncestor: (repo, before, after, sandbox) => gitSucceeds(repo, sandbox, ['merge-base', '--is-ancestor', before, after]),
        agentRoots(repo, commit, sandbox) {
            return boxGit(repo, sandbox, ['ls-tree', '-r', '--name-only', '-z', commit]).split('\0')
                .filter(file => /^[^/]+\/manifest\.json$/.test(file)).map(file => file.split('/')[0]);
        },
        changes(repo, before, after, sandbox) {
            const entries = boxGit(repo, sandbox, ['diff', '--raw', '--no-abbrev', '--no-renames', '-z', before, after, '--']).split('\0');
            const changes = [];
            for (let index = 0; index < entries.length - 1; index += 2) {
                const match = /^:([0-9]{6}) ([0-9]{6}) [a-f0-9]{40} [a-f0-9]{40} [ADM]$/.exec(entries[index]);
                prove(match && typeof entries[index + 1] === 'string', 'QA_UPDATE_DIFF_INVALID');
                changes.push({ oldMode: match[1], newMode: match[2], path: entries[index + 1] });
            }
            return changes;
        },
        fetch(repo, branch, commit, sandbox) {
            boxGit(repo, sandbox, ['fetch', '--no-tags', '--no-recurse-submodules', 'origin',
                `refs/heads/${branch}:refs/remotes/origin/${branch}`], { write: true, network: true, timeout: 120_000 });
            prove(boxGit(repo, sandbox, ['rev-parse', `refs/remotes/origin/${branch}`]).trim() === commit, 'QA_UPDATE_REMOTE_MOVED');
        },
        fastForward: (repo, commit, sandbox) => boxGit(repo, sandbox, ['merge', '--ff-only', '--no-edit', commit], { write: true }),
        restore: (repo, commit, sandbox) => boxGit(repo, sandbox, ['reset', '--keep', commit], { write: true }),
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
                sha256: file.deleted ? null : digest(boxGit(repository, { engine: item.engine, image: item.box.image },
                    ['show', `${commit}:${file.path}`], { encoding: 'buffer' })) }));
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

/** Usage is validated before any adapter, host or lock access. */
export function parseArguments(argv) {
    const [mode, ...flags] = argv;
    if (mode === 'plan' && flags.length === 0) return { mode };
    if (mode === 'select' && flags.length === 3 && flags[0] === '--expected-commit' && pinnedCommit(flags[1])
        && flags[2] === '--lock-held') return { mode, expectedCommit: flags[1] };
    if (mode === 'execute' && flags.length === 5 && flags[0] === '--receipt' && flags[1] && flags[2] === '--expected-commit'
        && pinnedCommit(flags[3]) && flags[4] === '--lock-held') return { mode, receipt: flags[1], expectedCommit: flags[3] };
    throw Object.assign(new Error('QA_UPDATE_USAGE_INVALID'), { code: 'QA_UPDATE_USAGE_INVALID' });
}

/** The caller must hold the host lock: a non-blocking attempt to take it has to fail with the busy status. */
export function assertHostLockHeld(lock = QA_SCOPE.lock, spawn = spawnSync) {
    const locked = spawn('flock', ['-n', '-E', '75', lock, 'true'], { encoding: 'utf8', timeout: 5000 });
    prove(!locked.error && locked.status === 75, 'QA_UPDATE_HOST_LOCK_REQUIRED');
}

export async function main(argv = process.argv.slice(2)) {
    const { mode, receipt, expectedCommit } = parseArguments(argv);
    const adapters = updateProductionAdapters();
    adapters.assertHost();
    if (mode !== 'plan') assertHostLockHeld();
    const service = createUpdateService(adapters);
    const result = mode === 'plan' ? await service.plan()
        : mode === 'select' ? await service.select({ expectedCommit })
            : await service.execute(receipt, { expectedCommit });
    process.stdout.write(JSON.stringify(result) + '\n');
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
