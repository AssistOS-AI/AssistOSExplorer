#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const QA_SCOPE = Object.freeze({
    workspace: '/home/admin/explorerQaWorkspace',
    backups: '/home/admin/.qa-deployment-backups',
    lock: '/home/admin/.qa-deployment-operation.lock',
    box: 'ploinky-box-explorerqaworkspace-7a31ab7775eb',
    hash: '7a31ab7775eb',
});
const FULL_ID = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const LABEL = 'io.assistos.ploinky-box.';
const AUTH_FILES = ['.env', '.ploinky/master-key', '.ploinky/.secrets', '.ploinky/passwords.enc',
    '.ploinky/ploinky_subject_identity_ed25519_v1.enc'];
const GENERATED_STATE = new Set(['agents.json', 'routing.json', 'running', 'run', 'logs', 'box', 'deps',
    'container-runtime', 'graph-skill-scope.json', 'data']);
const GENERATED_DATA = new Set(['edge-routing', 'edge-publication', 'router-security']);
// These reviewed files preserve existing and deliberately empty account stores.
// Changed implementations require a new review before prior-code recovery is allowed.
export const ACCOUNT_CAPABILITY = Object.freeze({
    'cli/utils/agents.js': '6999a75c2ab07ed4096b54c50d1cc8f4ce333c6dffa77d9dac711a42633b4ff6',
    'cli/utils/security/encryptedPasswordStore.js': '7b25995756f48c10eeb56a53508bd5321701977ac8f0bfdd752199136a0265a3',
    'cli/utils/security/passwordStoreLock.mjs': 'f23ec55e64bfc44d4ffe3ea37f08b441f7b1bf848c1303ea9d130f1bd934beaf',
});
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = stat => ({ device: String(stat.dev), inode: String(stat.ino), uid: stat.uid, gid: stat.gid });
const present = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function requireProof(condition, code) {
    if (!condition) throw Object.assign(new Error(code), { code });
}

function writeNew(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

export function accountCapability(root, reviewedFiles = ACCOUNT_CAPABILITY) {
    return Object.entries(reviewedFiles).every(([relative, expected]) => {
        const file = path.join(root, '.runtime/ploinky', relative), stat = present(file);
        return stat?.isFile() && !stat.isSymbolicLink() && digest(fs.readFileSync(file)) === expected;
    });
}

export function enableArguments(selection) {
    const args = ['enable', 'agent', `${selection.repo}/${selection.agent}`, '--auth',
        selection.auth === 'local' ? 'pwd' : selection.auth];
    if (selection.alias) args.push('as', selection.alias);
    return args;
}

/** The caller supplies an already admitted exact Box and pinned CLI operations. */
export async function restorePriorSelections({ selections, profile, readRegistry, enable }) {
    const restored = [];
    for (const selection of selections) {
        requireProof(NAME.test(selection.repo) && NAME.test(selection.agent)
            && (!selection.alias || NAME.test(selection.alias))
            && ['none', 'local', 'sso'].includes(selection.auth), 'QA_SELECTION_INVALID');
        const registry = await readRegistry();
        const matches = Object.values(registry).filter(row => row?.type === 'agent'
            && row.repoName === selection.repo && row.agentName === selection.agent && (row.alias || '') === selection.alias);
        requireProof(matches.length <= 1, 'QA_SELECTION_AMBIGUOUS');
        if (matches.length) {
            requireProof((matches[0].profile || 'default') === selection.profile && matches[0].auth?.mode === selection.auth,
                'QA_SELECTION_POLICY_CHANGED');
            continue;
        }
        requireProof(selection.profile === profile, 'QA_OPTIONAL_PROFILE_UNSUPPORTED');
        await enable(enableArguments(selection));
        restored.push(selection.name);
    }
    return { restored };
}

function directory(file) {
    const stat = fs.lstatSync(file);
    requireProof(stat.isDirectory() && !stat.isSymbolicLink(), 'QA_DIRECTORY_INVALID');
    requireProof(fs.realpathSync(file) === file, 'QA_DIRECTORY_ALIAS');
    return stat;
}

function secretIdentities(root) {
    return AUTH_FILES.flatMap(relative => {
        const file = path.join(root, relative), stat = present(file);
        if (!stat) return [];
        requireProof(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'QA_AUTH_FILE_INVALID');
        return [{ relative, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777,
            sha256: digest(fs.readFileSync(file)) }];
    });
}

function validateDesired(root) {
    const file = path.join(root, '.ploinky/edge-desired.json');
    requireProof(present(file)?.isFile() && !present(file).isSymbolicLink(), 'QA_INTENT_MISSING');
    const desired = readJson(file);
    requireProof(Object.keys(desired).sort().join(',') === 'cloudflare,hosts,media'
        && Object.keys(desired.hosts).join(',') === 'explorer-qa.axiologic.dev'
        && desired.hosts['explorer-qa.axiologic.dev'].agent === 'AchillesIDE/explorer'
        && desired.cloudflare?.tunnelId === '89dd05b5-05a7-4bd4-9626-ec4343b07c67'
        && desired.cloudflare.tunnelTokenSecret === 'publication/explorer-qa-tunnel'
        && desired.cloudflare.apiTokenSecret === 'publication/explorer-qa-api'
        && desired.media?.publicIPv4 === '45.136.70.141'
        && desired.media.addressMode === 'direct', 'QA_INTENT_NOT_DEDICATED');
    assert.deepEqual(desired.hosts['explorer-qa.axiologic.dev'], { agent: 'AchillesIDE/explorer',
        routerSurfaces: ['browser-auth', 'agent-mcp', 'user-admin', 'workspace-assets', 'blob-transfer', 'marketplace-ui', 'webchat', 'webtty'] });
    assert.deepEqual(desired.media, { publicIPv4: '45.136.70.141', addressMode: 'direct' });
    return digest(fs.readFileSync(file));
}

function selectedAgents(root) {
    const file = path.join(root, '.ploinky/agents.json');
    if (!present(file)) return [];
    return Object.entries(readJson(file)).filter(([name]) => name !== '_config').map(([name, row]) => {
        requireProof(row?.type === 'agent' && row.runtime === 'podman' && FULL_ID.test(row.containerId)
            && NAME.test(name) && NAME.test(row.repoName) && NAME.test(row.agentName)
            && (!row.alias || NAME.test(row.alias)) && ['none', 'local', 'sso'].includes(row.auth?.mode)
            && (!row.runMode || row.runMode === 'isolated'), 'QA_AGENT_SELECTION_UNSUPPORTED');
        return { name, repo: row.repoName, agent: row.agentName, alias: row.alias || '',
            profile: row.profile || 'default', auth: row.auth.mode, oldId: row.containerId };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

function sourceDirectories(root) {
    const selected = ['.runtime/ploinky', 'AdvancedLanguageAgent'];
    for (const relative of ['.ploinky/repos', '.ploinky/agentlib/generations']) {
        const container = path.join(root, relative);
        if (present(container)) {
            directory(container);
            selected.push(...fs.readdirSync(container).sort().map(name => path.join(relative, name)));
        }
    }
    return selected.filter(relative => present(path.join(root, relative)));
}

function durableEntries(root) {
    const entries = fs.readdirSync(root).filter(name => name !== '.ploinky');
    const state = path.join(root, '.ploinky');
    for (const name of fs.readdirSync(state)) if (!GENERATED_STATE.has(name)) entries.push(path.join('.ploinky', name));
    const data = path.join(state, 'data');
    if (present(data)) for (const name of fs.readdirSync(data)) {
        if (!GENERATED_DATA.has(name)) entries.push(path.join('.ploinky/data', name));
    }
    return entries;
}

export function sanitizeBox(item, scope = QA_SCOPE) {
    const labels = item?.Config?.Labels || {};
    const image = String(item?.Image || '').replace(/^sha256:/, '');
    const mounts = (item?.Mounts || []).map(({ Source, Destination, RW, Type }) => ({ Source, Destination, RW, Type }));
    requireProof(FULL_ID.test(item?.Id) && FULL_ID.test(image)
        && labels[LABEL + 'path-hash'] === scope.hash && labels[LABEL + 'role'] === 'box'
        && item.Config.User === 'podman' && item.HostConfig?.Privileged === false
        && item.HostConfig.Init === true && typeof item.State?.Running === 'boolean', 'QA_BOX_IDENTITY_INVALID');
    assert.deepEqual(item.HostConfig.PortBindings, {
        '7882/udp': [{ HostIp: '0.0.0.0', HostPort: '7882' }],
        '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8097' }],
    }, 'QA_BOX_PORTS_INVALID');
    requireProof(mounts.some(mount => mount.Source === scope.workspace && mount.Destination === '/workspace'
        && mount.RW === true && mount.Type === 'bind'), 'QA_BOX_WORKSPACE_INVALID');
    for (const destination of ['/opt/ploinky', '/opt/ploinky-agentlib']) {
        const found = mounts.filter(mount => mount.Destination === destination);
        requireProof(found.length === 1 && found[0].RW === false && found[0].Type === 'bind'
            && found[0].Source.startsWith(scope.workspace + '/'), 'QA_BOX_SOURCE_INVALID');
    }
    const imageReference = labels[LABEL + 'image-ref'] || item.ImageName;
    requireProof(/^[^\s]+@sha256:[a-f0-9]{64}$/.test(imageReference), 'QA_IMAGE_NOT_PINNED');
    return { id: item.Id, name: item.Name.replace(/^\//, ''), image, imageReference,
        running: item.State.Running, mounts, ports: item.HostConfig.PortBindings,
        contract: digest(JSON.stringify({ image, config: item.Config, hostConfig: item.HostConfig, mounts })) };
}

/** Filesystem behavior is real in tests; external runtime operations are injected. */
export function createRollbackService(adapters, scope = QA_SCOPE) {
    const paths = backup => {
        requireProof(path.dirname(backup) === scope.backups && /^redeploy-[A-Za-z0-9]{8}$/.test(path.basename(backup)), 'QA_BACKUP_PATH_INVALID');
        directory(scope.backups);
        directory(backup);
        requireProof((fs.statSync(backup).mode & 0o077) === 0 && fs.statSync(backup).uid === process.getuid(), 'QA_BACKUP_NOT_PRIVATE');
        return { authority: path.join(backup, 'rollback-authority.json'), previous: path.join(backup, 'workspace'),
            failed: path.join(backup, 'failed-workspace'), journal: path.join(backup, 'rollback-result.json') };
    };
    const pins = root => sourceDirectories(root).map(relative => ({ relative, ...adapters.sourcePin(path.join(root, relative)) }));
    const matches = (actual, expected, code) => requireProof(JSON.stringify(actual) === JSON.stringify(expected), code);
    const inventory = () => adapters.boxes();

    function capture(backup) {
        adapters.assertHost();
        const files = paths(backup);
        requireProof(fs.readdirSync(backup).length === 0, 'QA_BACKUP_NOT_EMPTY');
        const stat = present(scope.workspace);
        if (stat) directory(scope.workspace);
        const allBoxes = inventory();
        requireProof(allBoxes.every(item => item.box.name === scope.box
            || (item.box.running === false && item.box.name.startsWith(scope.box + '-'))), 'QA_UNSELECTED_ACTIVE_BOX');
        const boxes = allBoxes.filter(item => item.box.name === scope.box);
        requireProof(boxes.length <= 1, 'QA_BOX_AMBIGUOUS');
        const predecessor = boxes[0] || null;
        requireProof(!predecessor || stat, 'QA_PREDECESSOR_WORKSPACE_MISSING');
        const sources = stat ? pins(scope.workspace) : [];
        if (predecessor) requireProof(sources.some(source => source.relative === '.runtime/ploinky')
            && sources.some(source => source.relative === '.ploinky/repos/AchillesIDE'), 'QA_SOURCES_INCOMPLETE');
        if (predecessor) for (const destination of ['/opt/ploinky', '/opt/ploinky-agentlib']) {
            const mount = predecessor.box.mounts.find(item => item.Destination === destination);
            requireProof(sources.some(source => path.join(scope.workspace, source.relative) === mount.Source), 'QA_MOUNTED_SOURCE_NOT_CAPTURED');
        }
        const authority = { version: 1, workspace: scope.workspace, backup, machineId: adapters.machineId(),
            createdAt: new Date().toISOString(), workspaceIdentity: stat ? identity(stat) : null,
            predecessor, sources, auth: stat ? secretIdentities(scope.workspace) : [],
            desiredDigest: predecessor ? validateDesired(scope.workspace) : null,
            agents: stat ? selectedAgents(scope.workspace) : [],
            rollbackSupported: !predecessor || adapters.accountCapability(scope.workspace),
        };
        authority.rollbackCode = authority.rollbackSupported ? null : 'QA_PRIOR_CREDENTIAL_RUNTIME_UNSUPPORTED';
        if (predecessor) requireProof(authority.auth.some(file => file.relative === '.ploinky/master-key'), 'QA_MASTER_KEY_MISSING');
        writeNew(files.authority, authority);
        fs.writeFileSync(path.join(backup, 'prior-containers.txt'), predecessor
            ? `${predecessor.engine}|${predecessor.box.id}|${scope.box}\n` : '', { flag: 'wx', mode: 0o600 });
        return { result: 'captured', predecessorId: predecessor?.box.id || null, sources: sources.length,
            rollbackSupported: authority.rollbackSupported, rollbackCode: authority.rollbackCode };
    }

    function plan(backup, currentId) {
        adapters.assertHost();
        requireProof(currentId === 'absent' || FULL_ID.test(currentId), 'QA_CURRENT_ID_REQUIRED');
        const files = paths(backup);
        const authorityStat = present(files.authority);
        requireProof(authorityStat?.isFile() && !authorityStat.isSymbolicLink() && authorityStat.nlink === 1
            && authorityStat.uid === process.getuid() && (authorityStat.mode & 0o077) === 0, 'QA_AUTHORITY_FILE_INVALID');
        const authority = readJson(files.authority);
        requireProof(authority.version === 1 && authority.workspace === scope.workspace && authority.backup === backup
            && authority.machineId === adapters.machineId(), 'QA_AUTHORITY_IDENTITY_INVALID');
        requireProof(authority.predecessor && authority.workspaceIdentity, 'QA_NO_PREDECESSOR');
        requireProof(authority.rollbackSupported === true, 'QA_PRIOR_CREDENTIAL_RUNTIME_UNSUPPORTED');
        requireProof(!present(files.journal) && !present(files.failed), 'QA_ROLLBACK_ALREADY_ATTEMPTED');
        const predecessorId = authority.predecessor.box.id;
        requireProof(currentId !== predecessorId, 'QA_CURRENT_IS_PREDECESSOR');
        const previous = present(files.previous) ? files.previous : scope.workspace;
        matches(identity(directory(previous)), authority.workspaceIdentity, 'QA_PREVIOUS_WORKSPACE_CHANGED');
        matches(pins(previous), authority.sources, 'QA_PREVIOUS_SOURCES_CHANGED');
        requireProof(adapters.accountCapability(previous), 'QA_PRIOR_CREDENTIAL_RUNTIME_UNSUPPORTED');
        matches(secretIdentities(previous), authority.auth, 'QA_PREVIOUS_AUTH_CHANGED');
        requireProof(validateDesired(previous) === authority.desiredDigest, 'QA_PREVIOUS_INTENT_CHANGED');
        const records = fs.readFileSync(path.join(backup, 'prior-containers.txt'), 'utf8');
        requireProof(records === `${authority.predecessor.engine}|${predecessorId}|${scope.box}\n`, 'QA_PRIOR_RECORD_CHANGED');
        const boxes = inventory();
        const predecessor = boxes.filter(item => item.box.id === predecessorId && item.engine === authority.predecessor.engine);
        requireProof(predecessor.length === 1 && predecessor[0].box.contract === authority.predecessor.box.contract
            && [scope.box, `${scope.box}-rollback-${path.basename(backup)}`].includes(predecessor[0].box.name), 'QA_PREDECESSOR_CHANGED');
        const selectedCurrent = boxes.filter(item => item.box.id === currentId);
        requireProof(selectedCurrent.length <= 1, 'QA_CURRENT_AMBIGUOUS');
        const current = currentId === 'absent' ? null : selectedCurrent[0];
        requireProof(currentId === 'absent' || current?.box.name === scope.box, 'QA_CURRENT_CHANGED');
        requireProof(boxes.every(item => item.box.id === predecessorId || item.box.id === currentId
            || (item.box.running === false && item.box.name !== scope.box)), 'QA_UNSELECTED_ACTIVE_BOX');
        requireProof(!boxes.some(item => item.box.name === scope.box && item.box.id !== predecessorId && item.box.id !== currentId), 'QA_CURRENT_ABSENCE_UNPROVEN');
        requireProof(previous !== scope.workspace || currentId === 'absent', 'QA_WORKSPACE_OVERLAP');
        requireProof(adapters.imageId(authority.predecessor.engine, authority.predecessor.box.imageReference)
            === authority.predecessor.box.image, 'QA_PREVIOUS_IMAGE_CHANGED');
        adapters.checkPrerequisites(previous);
        return { authority, files, previous, predecessor: predecessor[0], current,
            targetIdentity: present(scope.workspace) ? identity(directory(scope.workspace)) : null };
    }

    async function execute(backup, currentId) {
        let selected = plan(backup, currentId);
        const workspaceLock = await adapters.acquireWorkspaceLock(selected.previous);
        try { selected = plan(backup, currentId); }
        catch (error) { workspaceLock.release(); throw error; }
        const { files, authority } = selected;
        const receipt = { version: 1, result: 'failed', phase: 'admitted', startedAt: new Date().toISOString(),
            predecessorId: authority.predecessor.box.id, failedId: selected.current?.box.id || null,
            backup, preservedPrevious: files.previous, failedWorkspace: files.failed, recoveryBoxId: null };
        try { writeNew(files.journal, receipt); }
        catch (error) { workspaceLock.release(); throw error; }
        const checkpoint = phase => {
            receipt.phase = phase;
            const temporary = files.journal + '.' + crypto.randomBytes(8).toString('hex');
            writeNew(temporary, receipt);
            fs.renameSync(temporary, files.journal);
        };
        const assertBox = captured => {
            const observed = inventory().find(item => item.engine === captured.engine && item.box.id === captured.box.id);
            requireProof(observed && observed.box.contract === captured.box.contract
                && observed.box.name === captured.box.name, 'QA_BOX_CHANGED_DURING_ROLLBACK');
            return observed;
        };
        const retire = async (captured, suffix) => {
            let observed = assertBox(captured);
            if (observed.box.running) {
                await adapters.quiesce(observed);
                assertBox(captured);
                adapters.stop(observed);
            }
            observed = assertBox(captured);
            requireProof(observed.box.running === false, 'QA_BOX_NOT_STOPPED');
            if (observed.box.name === scope.box) {
                adapters.rename(observed, scope.box + suffix);
                captured = { ...captured, box: { ...captured.box, name: scope.box + suffix } };
            }
            requireProof(assertBox(captured).box.running === false, 'QA_BOX_NOT_STOPPED');
        };
        try {
            checkpoint('quiescing');
            if (selected.current) await retire(selected.current, `-failed-${path.basename(backup)}`);
            await retire(selected.predecessor, `-rollback-${path.basename(backup)}`);
            checkpoint('preserving-workspaces');
            matches(present(scope.workspace) ? identity(directory(scope.workspace)) : null,
                selected.targetIdentity, 'QA_CURRENT_WORKSPACE_CHANGED');
            if (selected.previous === scope.workspace) fs.renameSync(scope.workspace, files.previous);
            else if (present(scope.workspace)) fs.renameSync(scope.workspace, files.failed);
            matches(identity(directory(files.previous)), authority.workspaceIdentity, 'QA_PREVIOUS_WORKSPACE_CHANGED');
            matches(pins(files.previous), authority.sources, 'QA_PREVIOUS_SOURCES_CHANGED');
            matches(secretIdentities(files.previous), authority.auth, 'QA_PREVIOUS_AUTH_CHANGED');
            checkpoint('copying-durable-state');
            fs.mkdirSync(scope.workspace, { mode: 0o700 });
            const copy = relative => {
                const from = path.join(files.previous, relative), to = path.join(scope.workspace, relative);
                if (present(from)) adapters.copy(from, to);
            };
            fs.mkdirSync(path.join(scope.workspace, '.ploinky'), { mode: 0o700 });
            for (const relative of durableEntries(files.previous)) copy(relative);
            matches(secretIdentities(scope.workspace), authority.auth, 'QA_RESTORED_AUTH_CHANGED');
            matches(pins(scope.workspace), authority.sources, 'QA_RESTORED_SOURCES_CHANGED');
            requireProof(validateDesired(scope.workspace) === authority.desiredDigest, 'QA_RESTORED_INTENT_CHANGED');
            for (const relative of ['agents.json', 'running', 'run', 'box', 'data/edge-routing', 'data/edge-publication', 'data/router-security']) {
                requireProof(!present(path.join(scope.workspace, '.ploinky', relative)), 'QA_GENERATED_STATE_RESTORED');
            }
            checkpoint('preparing-fresh-box');
            workspaceLock.release();
            const fresh = await adapters.prepare(authority);
            requireProof(FULL_ID.test(fresh.box.id) && ![receipt.predecessorId, receipt.failedId].includes(fresh.box.id)
                && fresh.box.name === scope.box && fresh.box.image === authority.predecessor.box.image
                && fresh.box.running, 'QA_RECOVERY_BOX_INVALID');
            receipt.recoveryBoxId = fresh.box.id;
            checkpoint('initializing-fresh-routing');
            await adapters.initialize(fresh);
            const policy = path.join(files.previous, '.ploinky/data/router-security');
            if (present(policy)) adapters.copy(policy, path.join(scope.workspace, '.ploinky/data/router-security'));
            matches(secretIdentities(scope.workspace), authority.auth, 'QA_RESTORED_AUTH_CHANGED');
            checkpoint('starting-prior-graph');
            await adapters.start(fresh, authority);
            checkpoint('checking-readiness');
            receipt.readiness = await adapters.ready(fresh, authority);
            requireProof(receipt.readiness?.ready === true, 'QA_RECOVERY_NOT_READY');
            requireProof(assertBox(fresh).box.running === true, 'QA_RECOVERY_BOX_STOPPED');
            matches(pins(scope.workspace), authority.sources, 'QA_RECOVERY_SOURCES_CHANGED');
            matches(secretIdentities(scope.workspace), authority.auth, 'QA_RECOVERY_AUTH_CHANGED');
            receipt.result = 'recovered';
            receipt.browserAcceptance = 'not-run';
            checkpoint('complete');
            return receipt;
        } catch (error) {
            receipt.code = /^QA_[A-Z_]+$/.test(error?.code || '') ? error.code : 'QA_ROLLBACK_STEP_FAILED';
            checkpoint(receipt.phase);
            throw Object.assign(new Error(receipt.code), { code: receipt.code, receipt });
        } finally {
            workspaceLock.release();
        }
    }
    return { capture, plan, execute };
}

function command(program, args, options = {}) {
    const result = spawnSync(program, args, { encoding: 'utf8', timeout: 120_000,
        stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, ...options });
    requireProof(!result.error && result.status === 0, 'QA_EXTERNAL_COMMAND_FAILED');
    return result.stdout.trim();
}

export function productionAdapters(scope = QA_SCOPE) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PLOINKY_|CLOUDFLARE_)/.test(key)));
    const inside = (item, source, args = [], timeout = 120_000) => command(item.engine,
        ['container', 'exec', '-i', '--user', 'podman', '--workdir', '/workspace',
            '--env', 'PLOINKY_WORKSPACE_ROOT=/workspace', item.box.id, 'node', '--input-type=module', '-', ...args],
        { input: source, timeout, env });
    const inspect = (engine, id) => {
        const records = JSON.parse(command(engine, ['container', 'inspect', id], { env }));
        requireProof(records.length === 1, 'QA_INSPECTION_AMBIGUOUS');
        return { engine, box: sanitizeBox(records[0], scope) };
    };
    const adapters = {
        accountCapability,
        async acquireWorkspaceLock(previous) {
            const { createMutationLockManager } = await import(path.join(previous, '.runtime/ploinky/ploinky-box/locks.mjs'));
            const lock = await createMutationLockManager().acquire(scope.box);
            let released = false;
            return { release() { if (!released) { lock.release(); released = true; } } };
        },
        assertHost() {
            requireProof(process.platform === 'linux' && os.userInfo().username === 'admin'
                && os.homedir() === '/home/admin' && scope.workspace === QA_SCOPE.workspace, 'QA_HOST_INVALID');
        },
        machineId: () => {
            const value = fs.readFileSync('/etc/machine-id', 'utf8').trim();
            requireProof(/^[a-f0-9]{32}$/.test(value), 'QA_MACHINE_ID_INVALID');
            return value;
        },
        sourcePin(directoryPath) {
            directory(directoryPath);
            directory(path.join(directoryPath, '.git'));
            const git = args => command('git', ['-c', `safe.directory=${directoryPath}`, '-C', directoryPath, ...args],
                { env: { ...env, GIT_OPTIONAL_LOCKS: '0' } });
            requireProof(git(['rev-parse', '--show-toplevel']) === directoryPath
                && git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']) === '', 'QA_SOURCE_NOT_CLEAN');
            const commit = git(['rev-parse', 'HEAD']);
            requireProof(/^[a-f0-9]{40}$/.test(commit), 'QA_SOURCE_COMMIT_INVALID');
            const origin = git(['remote', 'get-url', 'origin']);
            if (directoryPath.includes('/.ploinky/agentlib/generations/')) {
                requireProof(new RegExp(`^${commit}-[a-f0-9]{12}$`).test(path.basename(directoryPath))
                    && ['/workspace/.ploinky/agentlib/mirror.git', path.join(scope.workspace, '.ploinky/agentlib/mirror.git')].includes(origin), 'QA_SOURCE_ORIGIN_INVALID');
            } else requireProof(/^https:\/\/github\.com\/AssistOS-AI\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(origin), 'QA_SOURCE_ORIGIN_INVALID');
            return { commit, branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), origin };
        },
        boxes() {
            const result = [];
            for (const engine of ['podman', 'docker']) {
                const exists = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', engine], { encoding: 'utf8' });
                if (exists.status !== 0) continue;
                const ids = command(engine, ['container', 'ls', '-aq', '--no-trunc'], { env });
                for (const id of ids.split(/\s+/).filter(Boolean)) {
                    requireProof(FULL_ID.test(id), 'QA_ENGINE_ID_INVALID');
                    const rows = JSON.parse(command(engine, ['container', 'inspect', id], { env }));
                    requireProof(rows.length === 1 && rows[0].Id === id, 'QA_INSPECTION_AMBIGUOUS');
                    const item = rows[0];
                    if (item.Config?.Labels?.[LABEL + 'path-hash'] === scope.hash
                        || String(item.Name).replace(/^\//, '') === scope.box) result.push({ engine, box: sanitizeBox(item, scope) });
                }
            }
            return result;
        },
        imageId: (engine, reference) => JSON.parse(command(engine, ['image', 'inspect', reference], { env }))[0].Id.replace(/^sha256:/, ''),
        checkPrerequisites(previous) {
            command('sudo', ['-n', 'true']);
            for (const relative of ['.runtime/ploinky/bin/ploinky', '.runtime/ploinky/ploinky-box/supervisor.mjs',
                '.runtime/ploinky/cli/sandbox/edgeGeneration.js', '.ploinky/repos/AchillesIDE/explorer/manifest.json']) {
                requireProof(present(path.join(previous, relative))?.isFile(), 'QA_RECOVERY_API_MISSING');
            }
            requireProof(present(path.join(path.dirname(fileURLToPath(import.meta.url)), 'quiesce-explorer-qa.mjs'))?.isFile(), 'QA_QUIESCE_HELPER_MISSING');
            let needed = 64 * 1024 * 1024;
            const entries = durableEntries(previous);
            if (present(path.join(previous, '.ploinky/data/router-security'))) entries.push('.ploinky/data/router-security');
            for (const relative of entries) {
                const size = command('sudo', ['-n', 'du', '-s', '--apparent-size', '-B1', '--', path.join(previous, relative)], { timeout: 120_000 }).match(/^([0-9]+)\s/);
                requireProof(size && Number.isSafeInteger(Number(size[1])), 'QA_SPACE_PROOF_INVALID');
                needed += Number(size[1]);
            }
            const available = command('df', ['-B1', '--output=avail', '--', scope.backups]).split(/\s+/).at(-1);
            requireProof(/^[0-9]+$/.test(available) && Number.isSafeInteger(Number(available)), 'QA_SPACE_PROOF_INVALID');
            requireProof(Number(available) >= needed, 'QA_RECOVERY_SPACE_INSUFFICIENT');
        },
        async quiesce(item) {
            const source = fs.readFileSync(new URL('./quiesce-explorer-qa.mjs', import.meta.url), 'utf8');
            const receipt = JSON.parse(inside(item, source, [], 180_000));
            requireProof(receipt.result === 'passed', 'QA_QUIESCE_FAILED');
        },
        stop: item => command(item.engine, ['container', 'stop', '--time', '30', item.box.id], { env, timeout: 45_000 }),
        rename: (item, name) => command(item.engine, ['container', 'rename', item.box.id, name], { env }),
        copy(from, to) {
            fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
            const merge = present(to)?.isDirectory() && present(from)?.isDirectory();
            command('sudo', ['-n', 'cp', '-a', '--reflink=auto', '--', merge ? `${from}/.` : from, to], { timeout: 600_000 });
            command('sudo', ['-n', process.execPath, '--input-type=module', '-e', `
                import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
                import {spawnSync} from 'node:child_process';
                function compare(left,right,merge=false) {
                    const a=fs.lstatSync(left),b=fs.lstatSync(right);
                    assert.equal(a.mode,b.mode); assert.equal(a.uid,b.uid); assert.equal(a.gid,b.gid);
                    if(a.isSymbolicLink()) assert.equal(fs.readlinkSync(left),fs.readlinkSync(right));
                    else if(a.isFile()) assert.equal(spawnSync('cmp',['-s','--',left,right]).status,0);
                    else if(a.isDirectory()) {
                        if(!merge) assert.deepEqual(fs.readdirSync(left).sort(),fs.readdirSync(right).sort());
                        for(const name of fs.readdirSync(left)) compare(path.join(left,name),path.join(right,name));
                    } else throw Error('unsupported durable file');
                }
                compare(process.argv[1],process.argv[2],process.argv[3]==='true');
            `, from, to, String(merge)], { timeout: 600_000 });
        },
        async prepare(authority) {
            const script = `const {createBoxSupervisor}=await import(process.argv[1]); await createBoxSupervisor().prepareBoxForCommand({explicitPort:8097,explicitMediaPort:7882});`;
            command('node', ['--input-type=module', '-e', script, path.join(scope.workspace, '.runtime/ploinky/ploinky-box/supervisor.mjs')],
                { cwd: scope.workspace, env: { ...env, PLOINKY_WORKSPACE_ROOT: scope.workspace,
                    PLOINKY_BOX_IMAGE: authority.predecessor.box.imageReference }, timeout: 600_000 });
            return inspect(authority.predecessor.engine, scope.box);
        },
        async initialize(item) {
            inside(item, `
                const {readSecretsFile}=await import('/opt/ploinky/cli/utils/security/encryptedSecretsFile.js');
                const secrets=readSecretsFile();
                for(const key of ['publication/explorer-qa-tunnel','publication/explorer-qa-api']) {
                    if(typeof secrets[key]!=='string'||!secrets[key]) throw Error('missing preserved credential');
                }
                const {initializeFreshEdgeRoutingSources}=await import('/opt/ploinky/cli/sandbox/edgeGeneration.js');
                initializeFreshEdgeRoutingSources({workspaceRoot:'/workspace'});
            `);
        },
        async start(item, authority) {
            const cli = path.join(scope.workspace, '.runtime/ploinky/bin/ploinky');
            const options = { cwd: scope.workspace, env: { ...env, PLOINKY_WORKSPACE_ROOT: scope.workspace,
                PLOINKY_BOX_IMAGE: authority.predecessor.box.imageReference }, timeout: 600_000 };
            command(cli, ['start', 'explorer'], options);
            const profileFile = path.join(scope.workspace, '.ploinky/profile');
            await restorePriorSelections({ selections: authority.agents,
                profile: present(profileFile) ? fs.readFileSync(profileFile, 'utf8').trim() || 'default' : 'default',
                readRegistry: () => JSON.parse(inside(item, `import fs from 'node:fs'; process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync('/workspace/.ploinky/agents.json','utf8'))));`)),
                enable: args => command(cli, args, options),
            });
        },
        async ready(item, authority) {
            const script = `
                const expected=JSON.parse(process.argv[2]);
                const {getAgentsRegistry}=await import('/opt/ploinky/cli/sandbox/docker/containerRegistry.js');
                const {collectAgentRuntimeStatesAsync}=await import('/opt/ploinky/cli/sandbox/agentRuntimeState.js');
                const {applyRuntimeReadinessProjection}=await import('/opt/ploinky/cli/utils/noWaitReadiness.js');
                const {loadActiveEdgeRoutingGeneration}=await import('/opt/ploinky/cli/sandbox/edgeGeneration.js');
                const registry=getAgentsRegistry();
                const states=applyRuntimeReadinessProjection(await collectAgentRuntimeStatesAsync({registry}),registry);
                const active=loadActiveEdgeRoutingGeneration({workspaceRoot:'/workspace'});
                const matches=expected.every(old=>states.some(row=>row.repoName===old.repo&&row.agentName===old.agent
                    &&(registry[row.containerName]?.alias||'')===old.alias&&registry[row.containerName]?.containerId!==old.oldId
                    &&(registry[row.containerName]?.profile||'default')===old.profile&&registry[row.containerName]?.auth?.mode===old.auth));
                const failed=states.some(row=>['failed','error'].includes(row.state?.noWaitState));
                const ready=matches&&states.length>=expected.length&&active.selector.publicationState==='ready'
                    &&states.every(row=>row.enabled&&row.state?.running&&row.state.status==='running'
                        &&(row.state.noWaitState===undefined||(row.state.noWaitState==='running'&&row.state.ready===true)));
                process.stdout.write(JSON.stringify({ready,failed,generation:active.selector.generation,count:states.length}));
            `;
            const deadline = Date.now() + 900_000;
            while (Date.now() < deadline) {
                let result;
                try { result = JSON.parse(inside(item, script, [JSON.stringify(authority.agents)])); }
                catch { result = { ready: false }; }
                requireProof(result.failed !== true, 'QA_RECOVERY_RUNTIME_FAILED');
                if (result.ready) return result;
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
            throw Object.assign(new Error('QA_RECOVERY_DEADLINE'), { code: 'QA_RECOVERY_DEADLINE' });
        },
    };
    return adapters;
}

export async function main(argv = process.argv.slice(2)) {
    const [mode, backup, ...flags] = argv;
    requireProof(['capture', 'plan', 'execute'].includes(mode) && path.isAbsolute(backup || ''), 'QA_USAGE_INVALID');
    const lockHeld = flags.includes('--lock-held');
    const remaining = flags.filter(flag => flag !== '--lock-held');
    requireProof(mode === 'capture' ? remaining.length === 0
        : remaining.length === 2 && remaining[0] === '--current-id', 'QA_USAGE_INVALID');
    const adapters = productionAdapters();
    adapters.assertHost();
    if (mode !== 'plan') {
        if (!lockHeld) {
            const result = spawnSync('flock', ['-n', '-E', '75', '--close', QA_SCOPE.lock,
                process.execPath, fileURLToPath(import.meta.url), ...argv, '--lock-held'], { stdio: 'inherit', timeout: 2_700_000 });
            requireProof(!result.error && result.status === 0, 'QA_LOCKED_OPERATION_FAILED');
            return;
        }
        const locked = spawnSync('flock', ['-n', '-E', '75', QA_SCOPE.lock, 'true'], { encoding: 'utf8', timeout: 5000 });
        requireProof(locked.status === 75, 'QA_HOST_LOCK_REQUIRED');
    }
    const service = createRollbackService(adapters);
    let receipt;
    if (mode === 'capture') receipt = service.capture(backup);
    else if (mode === 'plan') {
        const plan = service.plan(backup, remaining[1]);
        receipt = { result: 'planned', predecessorId: plan.predecessor.box.id,
            currentId: plan.current?.box.id || null, image: plan.authority.predecessor.box.image,
            sourceCount: plan.authority.sources.length, mutations: false };
    } else receipt = await service.execute(backup, remaining[1]);
    process.stdout.write(JSON.stringify(receipt) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { await main(); } catch (error) {
        process.stdout.write(JSON.stringify(error.receipt || { result: 'failed',
            code: /^QA_[A-Z_]+$/.test(error?.code || '') ? error.code : 'QA_ROLLBACK_REJECTED' }) + '\n');
        process.exitCode = 1;
    }
}
