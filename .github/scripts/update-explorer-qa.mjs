#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { productionAdapters, QA_SCOPE } from './rollback-explorer-qa.mjs';

export const EXPLORER_SOURCE = '.ploinky/repos/AchillesIDE';
const COMMIT = /^[a-f0-9]{40}$/;
const ID = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SOURCE_ORIGIN = /^https:\/\/github\.com\/AssistOS-AI\/AssistOSExplorer(?:\.git)?$/i;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const present = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

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
            affected.add(root);
        }
    }
    return { affected: [...affected].sort(), shared };
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
            if (!touched.includes(prior.name)) prove(current.id === prior.id && current.image === prior.image,
                'QA_UPDATE_UNRELATED_AGENT_CHANGED');
            else prove(current.image === prior.image || (recovering && current.image === null), 'QA_UPDATE_AGENT_IMAGE_CHANGED');
        }
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
        return { ...remote, changedPaths: changes.length, affected: affectedAgents(value, classified), local: true };
    }

    async function plan() {
        const value = await snapshot();
        assertReady(value);
        await adapters.health(value.current);
        const next = await candidate(value);
        return { result: 'planned', mutations: false, boxId: value.current.box.id, imageId: value.current.box.image,
            previousCommit: source(value).commit, candidateCommit: next.commit, branch: next.branch,
            changeValidation: next.local ? 'passed' : 'requires-fetch', changedPaths: next.changedPaths,
            agents: next.affected?.map(agent => `AchillesIDE/${agent.agent}`) || null };
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
            ...(receipt.code ? { code: receipt.code } : {}) });
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
            receipt.status = 'updated'; receipt.completedAt = new Date().toISOString(); writeReceipt();
            return report();
        } catch (error) {
            if (!changed || !receipt) throw error;
            receipt.status = 'failed';
            receipt.code = /^QA_[A-Z_]+$/.test(error.code || '') ? error.code : 'QA_UPDATE_FAILED';
            try {
                if (!lock) await acquire();
                assertRetained(await snapshot(), authority, next.commit, touched, true);
                // --keep plus exact clean-candidate proof cannot discard user work.
                adapters.restore(repository, source(authority).commit);
                assertRetained(await snapshot(), authority, source(authority).commit, touched, true);
                receipt.rollback = 'source-restored'; writeReceipt();
                for (const name of touched) {
                    const agent = authority.runtime.agents.find(row => row.name === name);
                    assertRetained(await snapshot(), authority, source(authority).commit, touched, true);
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
                receipt.rollbackCode = /^QA_[A-Z_]+$/.test(rollbackError.code || '') ? rollbackError.code : 'QA_UPDATE_ROLLBACK_FAILED';
            }
            writeReceipt();
            throw Object.assign(new Error(receipt.code), { code: receipt.code, receipt: report() });
        } finally { release(); }
    }
    return { plan, execute };
}

function command(executable, args, options = {}) {
    const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    prove(!result.error && result.status === 0, 'QA_UPDATE_EXTERNAL_COMMAND_FAILED');
    return result.stdout;
}

export function updateProductionAdapters(scope = QA_SCOPE) {
    const base = productionAdapters(scope);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PLOINKY_|CLOUDFLARE_|GIT_)/.test(key)));
    const git = (repo, args, options = {}) => command('git', ['-c', `safe.directory=${repo}`,
        '-c', 'core.hooksPath=/dev/null', '-C', repo, ...args],
    { env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, ...options });
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
            command(path.join(scope.workspace, '.runtime/ploinky/bin/ploinky'), ['restart', `AchillesIDE/${agent.agent}`],
                { cwd: scope.workspace, timeout: 600_000, env: { ...env, PLOINKY_WORKSPACE_ROOT: scope.workspace,
                    PLOINKY_BOX_IMAGE: item.box.imageReference, PLOINKY_ROUTER_HOST_PORT: '8097', PLOINKY_MEDIA_HOST_PORT: '7882' } });
        },
        async health() {
            const { checkBoxHealth } = await import(pathToFileURL(path.join(scope.workspace, '.runtime/ploinky/ploinky-box/supervisor.mjs')).href);
            await checkBoxHealth(8097, { timeoutMs: 5000, readinessTimeoutMs: 0 });
        },
        async runtime(item) {
            const script = `
                import {spawnSync} from 'node:child_process';
                import {getAgentsRegistry} from '/opt/ploinky/cli/sandbox/docker/containerRegistry.js';
                import {collectAgentRuntimeStatesAsync} from '/opt/ploinky/cli/sandbox/agentRuntimeState.js';
                import {applyRuntimeReadinessProjection} from '/opt/ploinky/cli/utils/noWaitReadiness.js';
                import {loadActiveEdgeRoutingGeneration} from '/opt/ploinky/cli/sandbox/edgeGeneration.js';
                const registry = getAgentsRegistry();
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
                    return {name,repo:row.repoName,agent:row.agentName,alias:row.alias||'',profile:row.profile||'default',
                        auth:row.auth?.mode,runMode:row.runMode||'isolated',...(row.runMode==='devel'?{develRepo:row.develRepo}:{}),
                        instanceId:row.instanceId,enableGeneration:row.enableGeneration,id:row.containerId,
                        image:inspected[0]?.Image||null,ready};
                });
                let active = false;
                try { const value = loadActiveEdgeRoutingGeneration(); active = value.selector.state === 'active' && value.selector.publicationState === 'ready'; }
                catch {}
                process.stdout.write(JSON.stringify({agents,active}));
            `;
            return JSON.parse(command(item.engine, ['container', 'exec', '-i', '--user', 'podman', '--workdir', scope.workspace,
                '--env', `PLOINKY_WORKSPACE_ROOT=${scope.workspace}`, '--env', 'PLOINKY_ROUTER_HOST_PORT=8097',
                '--env', 'PLOINKY_MEDIA_HOST_PORT=7882', item.box.id, 'node', '--input-type=module', '-'],
            { env, input: script, timeout: 120_000 }));
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
            code: /^QA_[A-Z_]+$/.test(error.code || '') ? error.code : 'QA_UPDATE_REJECTED' }) + '\n');
        process.exitCode = 1;
    }
}
