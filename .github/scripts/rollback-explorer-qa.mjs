#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const QA_SCOPE = Object.freeze({
    workspace: '/home/admin/explorerQaWorkspace',
    backups: '/home/admin/.qa-deployment-backups',
    lock: '/home/admin/.qa-deployment-operation.lock',
    box: 'ploinky-box-explorerqaworkspace-7a31ab7775eb',
    hash: '7a31ab7775eb',
});
// Full graph shutdown includes sequential service drains and identity checks.
export const QUIESCE_EXEC_TIMEOUT_MS = 900_000;
const FULL_ID = /^[a-f0-9]{64}$/;
const LABEL = 'io.assistos.ploinky-box.';
// The image owns its AchillesAgentLib checks. Ploinky runs the same probe; it
// lives outside every host mount, so it is the image's own copy.
const AGENTLIB_IMAGE_PROBE = '/usr/local/share/ploinky/smoke-libraries.mjs';
// Boxes created by a Ploinky release before image-owned libraries labelled the
// bundled commit and fingerprint and shipped this verifier. They are admitted
// only as predecessors to capture and roll back, never as the current QA Box.
const LEGACY_AGENTLIB_IMAGE_PROBE = '/usr/local/share/ploinky/agentlib/image-bundle.mjs';
const AGENTLIB_IMAGE_PATH = '/opt/ploinky-agentlib';
const AGENTLIB_PACKAGE_NAME = 'ploinky-agent-lib';
const BOX_IMAGE_ID_ENV = 'PLOINKY_BOX_IMAGE_ID';
// Ploinky's workspace Box state directory, which holds the workspace mutation lock.
const HOST_STATE_DIRECTORY = '.ploinky-box';
// The read-only checks a source pin needs. They run inside a throwaway sandbox,
// never in the host process, because the Box can write these repositories and
// their Git configuration (core.fsmonitor, hooks, filters) would run on the host.
const SOURCE_PATH = /^\/[A-Za-z0-9_.\/-]+$/;
export const SOURCE_CHECK_SCRIPT = `import { spawnSync } from 'node:child_process';
const directory = process.argv[2];
const git = args => {
    const result = spawnSync('git', ['-c', 'safe.directory=' + directory, '-c', 'core.fsmonitor=false',
        '-c', 'core.untrackedCache=false', '-C', directory, ...args], { encoding: 'utf8',
        timeout: 60000, maxBuffer: 8 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', HOME: '/tmp', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
    return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
};
process.stdout.write(JSON.stringify({ toplevel: git(['rev-parse', '--show-toplevel']),
    status: git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']),
    head: git(['rev-parse', 'HEAD']), origin: git(['remote', 'get-url', 'origin']),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    upstream: git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) }));
`;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function requireProof(condition, code) {
    if (!condition) throw Object.assign(new Error(code), { code });
}

/**
 * The default Explorer graph the current workflow starts; the optional-agent
 * default tests compare their expectations against it.
 */
export const EXPECTED_DEFAULT_GRAPH = Object.freeze([
    'AchillesIDE/explorer', 'AchillesIDE/gitAgent', 'AchillesIDE/userPersistoAgent', 'AchillesIDE/emailAgent',
    'AchillesIDE/dpuAgent', 'AchillesIDE/roboTeamAgent', 'AchillesIDE/soul-gateway', 'AchillesIDE/workspaceMonitorAgent',
    'local-llms/local-llm',
]);

function directory(file) {
    const stat = fs.lstatSync(file);
    requireProof(stat.isDirectory() && !stat.isSymbolicLink(), 'QA_DIRECTORY_INVALID');
    requireProof(fs.realpathSync(file) === file, 'QA_DIRECTORY_ALIAS');
    return stat;
}

function assertImageAgentLibMounts(mounts) {
    requireProof(Array.isArray(mounts), 'QA_AGENTLIB_IMAGE_SHADOWED');
    // The package, both verifiers, the provenance record and their interpreter.
    const protectedPaths = [AGENTLIB_IMAGE_PATH, path.posix.dirname(AGENTLIB_IMAGE_PROBE), '/usr/local/bin/node'];
    requireProof(mounts.every(mount => {
        const destination = mount.Destination;
        if (typeof destination !== 'string' || !destination.startsWith('/') || destination.includes('\\')) return false;
        const normalized = path.posix.normalize(destination);
        return protectedPaths.every(protectedPath => normalized !== '/' && normalized !== protectedPath
            && !normalized.startsWith(protectedPath + '/') && !protectedPath.startsWith(normalized.replace(/\/$/, '') + '/'));
    }), 'QA_AGENTLIB_IMAGE_SHADOWED');
}

/** Image metadata is accepted only after the independent sealed verifier runs. */
function assertAgentLibImageIdentity(image, imageProof) {
    requireProof(imageProof && String(imageProof.Id).replace(/^sha256:/, '') === image
        && imageProof.Os === 'linux' && imageProof.Architecture === 'amd64'
        && imageProof.Config?.User === 'podman', 'QA_AGENTLIB_IMAGE_IDENTITY_INVALID');
}

/** Whether image-mode labels follow the retired commit-labelled contract. */
function isLegacyImageAgentLib(labels) {
    return Object.hasOwn(labels, LABEL + 'agentlib-commit') || Object.hasOwn(labels, LABEL + 'agentlib-fingerprint');
}

/** Ploinky's source identity of the AchillesAgentLib an outer image supplies: that image and the library. */
export function imageAgentLibSourceId(imageId) {
    return digest(JSON.stringify({ kind: 'image', library: 'achillesAgentLib', supplyingImageId: imageId }));
}

/**
 * The package report of the image's own probe. As in Ploinky, the package must
 * be AchillesAgentLib; the build provenance is diagnostic and never compared.
 */
function libraryReport(report, code) {
    requireProof(report?.schema === 'ploinky.box.library-inspect/v1' && report.library === 'achillesAgentLib'
        && report.packageName === AGENTLIB_PACKAGE_NAME
        && (report.packageVersion === null || (typeof report.packageVersion === 'string' && report.packageVersion)), code);
    const provenance = report.provenance && typeof report.provenance === 'object'
        && typeof report.provenance.repository === 'string' && /^[a-f0-9]{40}$/.test(String(report.provenance.commit))
        ? { repository: report.provenance.repository, branch: report.provenance.branch ?? null, commit: report.provenance.commit }
        : null;
    return { packageName: report.packageName, packageVersion: report.packageVersion, provenance };
}

function imageOwnedAgentLib(item, labels, image, imageProof) {
    const imageId = `sha256:${image}`;
    const sourceId = labels[LABEL + 'agentlib-source-id'];
    requireProof(labels[LABEL + 'agentlib-source-path'] === 'image' && sourceId === imageAgentLibSourceId(imageId),
        'QA_AGENTLIB_IMAGE_LABELS_INVALID');
    const imageIdEnv = (Array.isArray(item.Config?.Env) ? item.Config.Env : [])
        .filter(entry => String(entry).startsWith(`${BOX_IMAGE_ID_ENV}=`));
    requireProof(imageIdEnv.length === 1 && imageIdEnv[0] === `${BOX_IMAGE_ID_ENV}=${imageId}`, 'QA_AGENTLIB_IMAGE_ID_ENV_INVALID');
    const library = libraryReport(imageProof.agentLibInspection, 'QA_AGENTLIB_IMAGE_BUNDLE_INVALID');
    requireProof(!item.State.Running || JSON.stringify(libraryReport(imageProof.runtimeAgentLibInspection,
        'QA_AGENTLIB_RUNTIME_BUNDLE_INVALID')) === JSON.stringify(library), 'QA_AGENTLIB_RUNTIME_BUNDLE_INVALID');
    return { mode: 'image', contract: 'image-owned', imageId, sourceId, sourceRelativePath: 'image', ...library };
}

function legacyImageAgentLibSelection(item, labels, image, imageProof) {
    const commit = labels[LABEL + 'agentlib-commit'];
    const fingerprint = labels[LABEL + 'agentlib-fingerprint'];
    const sourceId = labels[LABEL + 'agentlib-source-id'];
    requireProof(/^[a-f0-9]{40}$/.test(commit || '') && FULL_ID.test(fingerprint || '')
        && labels[LABEL + 'agentlib-source-path'] === 'image'
        && sourceId === digest(`image:sha256:${image}:${fingerprint}`), 'QA_AGENTLIB_IMAGE_LABELS_INVALID');
    const expected = { schemaVersion: 1, commit, fingerprint };
    const matches = proof => proof && proof.schemaVersion === expected.schemaVersion
        && proof.commit === commit && proof.fingerprint === fingerprint;
    requireProof(matches(imageProof.agentLibBundle), 'QA_AGENTLIB_IMAGE_BUNDLE_INVALID');
    requireProof(!item.State.Running || matches(imageProof.runtimeAgentLibBundle), 'QA_AGENTLIB_RUNTIME_BUNDLE_INVALID');
    return { mode: 'image', imageId: `sha256:${image}`, commit, fingerprint, sourceId, sourceRelativePath: 'image' };
}

function imageAgentLib(item, mounts, imageProof, imageReference) {
    const labels = item.Config.Labels;
    const image = String(item.Image || '').replace(/^sha256:/, '');
    assertAgentLibImageIdentity(image, imageProof);
    requireProof(imageProof.verifiedImageReference === imageReference
        && String(imageProof.referenceImageId || '').replace(/^sha256:/, '') === image, 'QA_AGENTLIB_IMAGE_REFERENCE_CHANGED');
    assertImageAgentLibMounts(mounts);
    return isLegacyImageAgentLib(labels)
        ? legacyImageAgentLibSelection(item, labels, image, imageProof)
        : imageOwnedAgentLib(item, labels, image, imageProof);
}

/**
 * A QA Box takes AchillesAgentLib from its own image under the image-owned
 * contract. Anything else is an unexpected state that must not be deployed on.
 */
export function assertImageOwnedAgentLib(selection) {
    if (selection?.mode === 'image' && selection.contract === 'image-owned') return selection;
    const observed = !selection?.mode ? 'no AgentLib selection'
        : selection.mode === 'image' ? 'image mode under the retired commit-labelled contract'
            : `${selection.mode} mode`;
    throw Object.assign(new Error(`QA_AGENTLIB_IMAGE_MODE_REQUIRED: the QA Box uses ${observed}. `
        + 'A QA Box must take AchillesAgentLib from its Box image. Remove any achillesAgentLib checkout from the QA '
        + 'workspace, deploy the Ploinky release with image-owned libraries, then redeploy.'),
    { code: 'QA_AGENTLIB_IMAGE_MODE_REQUIRED' });
}

function inspectBoxIdentity(item, scope) {
    const labels = item?.Config?.Labels || {};
    const image = String(item?.Image || '').replace(/^sha256:/, '');
    requireProof(Array.isArray(item?.Mounts), 'QA_BOX_SOURCE_INVALID');
    const mounts = item.Mounts.map(({ Source, Destination, RW, Type }) => ({ Source, Destination, RW, Type }));
    requireProof(FULL_ID.test(item?.Id) && FULL_ID.test(image)
        && labels[LABEL + 'path-hash'] === scope.hash && labels[LABEL + 'role'] === 'box'
        && item.Config.User === 'podman' && item.HostConfig?.Privileged === false
        && item.HostConfig.Init === true && typeof item.State?.Running === 'boolean', 'QA_BOX_IDENTITY_INVALID');
    const ports = structuredClone(item.HostConfig.PortBindings);
    // Podman can encode an IPv4 wildcard publication as an empty HostIp.
    // Compare its meaning here while retaining the raw inspection in the identity digest.
    if (ports?.['7882/udp']?.length === 1 && ports['7882/udp'][0]?.HostIp === '') {
        ports['7882/udp'][0].HostIp = '0.0.0.0';
    }
    assert.deepEqual(ports, {
        '7882/udp': [{ HostIp: '0.0.0.0', HostPort: '7882' }],
        '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8097' }],
    }, 'QA_BOX_PORTS_INVALID');
    // The host workspace is mounted at its own absolute path and selected as the
    // Box working directory and workspace root; there is no fixed alias.
    const workspaceMounts = mounts.filter(mount => mount.Destination === scope.workspace);
    const workspaceRoots = (Array.isArray(item.Config?.Env) ? item.Config.Env : [])
        .filter(entry => String(entry).startsWith('PLOINKY_WORKSPACE_ROOT='));
    requireProof(workspaceMounts.length === 1 && workspaceMounts[0].Source === scope.workspace
        && workspaceMounts[0].RW === true && workspaceMounts[0].Type === 'bind'
        && item.Config.WorkingDir === scope.workspace
        && workspaceRoots.length === 1 && workspaceRoots[0] === `PLOINKY_WORKSPACE_ROOT=${scope.workspace}`
        && !mounts.some(mount => mount.Destination === '/workspace'), 'QA_BOX_WORKSPACE_INVALID');
    const agentLibMode = String(labels[LABEL + 'agentlib-mode'] || '');
    requireProof(['', 'local', 'managed', 'image'].includes(agentLibMode), 'QA_AGENTLIB_MODE_INVALID');
    for (const destination of ['/opt/ploinky', ...(agentLibMode === 'image' ? [] : [AGENTLIB_IMAGE_PATH])]) {
        const found = mounts.filter(mount => mount.Destination === destination);
        requireProof(found.length === 1 && found[0].RW === false && found[0].Type === 'bind'
            && found[0].Source.startsWith(scope.workspace + '/'), 'QA_BOX_SOURCE_INVALID');
    }
    // Every Box shadows the mounted checkout read-only at its own workspace path
    // and masks the Box state directory with its read-only `empty/` directory.
    // A Box built by an earlier runtime has neither, and is refused here.
    const checkout = mounts.find(mount => mount.Destination === '/opt/ploinky').Source;
    const shadows = mounts.filter(mount => mount.Destination === checkout);
    const hostState = path.join(scope.workspace, HOST_STATE_DIRECTORY);
    const masks = mounts.filter(mount => mount.Destination === hostState);
    requireProof(shadows.length === 1 && shadows[0].Source === checkout && shadows[0].RW === false && shadows[0].Type === 'bind'
        && masks.length === 1 && masks[0].Source === path.join(hostState, 'empty') && masks[0].RW === false
        && masks[0].Type === 'bind', 'QA_BOX_SOURCE_INVALID');
    if (agentLibMode === 'image') assertImageAgentLibMounts(mounts);
    return { labels, image, mounts, agentLibMode };
}

export function sanitizeBox(item, scope = QA_SCOPE, imageProof = null) {
    const { labels, image, mounts, agentLibMode } = inspectBoxIdentity(item, scope);
    let imageReference = labels[LABEL + 'image-ref'] || item.ImageName;
    if (!/^[^\s]+@sha256:[a-f0-9]{64}$/.test(imageReference)) {
        // Older Boxes recorded the tag used at creation. Their exact local image
        // inspection can prove an immutable repository digest without resolving that tag again.
        requireProof(imageProof && String(imageProof.Id).replace(/^sha256:/, '') === image
            && imageProof.Os === 'linux' && imageProof.Architecture === 'amd64', 'QA_IMAGE_NOT_PINNED');
        const references = (Array.isArray(imageProof.RepoDigests) ? imageProof.RepoDigests : [])
            .filter(reference => /^docker\.io\/assistos\/ploinky-box@sha256:[a-f0-9]{64}$/.test(reference)).sort();
        requireProof(references.length > 0, 'QA_IMAGE_NOT_PINNED');
        imageReference = references[0];
    }
    const agentLib = agentLibMode === 'image' ? imageAgentLib(item, mounts, imageProof, imageReference) : agentLibMode ? {
        mode: agentLibMode, commit: labels[LABEL + 'agentlib-commit'],
        fingerprint: labels[LABEL + 'agentlib-fingerprint'], sourceId: labels[LABEL + 'agentlib-source-id'],
        sourceRelativePath: labels[LABEL + 'agentlib-source-path'],
    } : null;
    return { id: item.Id, name: item.Name.replace(/^\//, ''), image, imageReference,
        running: item.State.Running, mounts, ports: item.HostConfig.PortBindings,
        ...(agentLib ? { agentLib } : {}),
        contract: digest(JSON.stringify({ image, config: item.Config, hostConfig: item.HostConfig, mounts })) };
}

/**
 * The one running exact-name QA Box. Boxes retained for rollback by a preserving
 * redeploy are admitted only when stopped and named for a redeploy backup.
 */
export function currentQaBox(boxes, scope = QA_SCOPE) {
    const exact = boxes.filter(item => item.box.name === scope.box);
    requireProof(exact.length === 1 && exact[0].box.running === true
        && boxes.every(item => item === exact[0] || (item.box.running === false
            && item.box.name.startsWith(scope.box + '-')
            && /^(?:rollback|failed)-redeploy-[A-Za-z0-9]{8}$/.test(item.box.name.slice(scope.box.length + 1)))),
    'QA_EXACT_RUNNING_BOX_REQUIRED');
    return exact[0];
}

/**
 * Takes the QA workspace mutation lock from the imported Ploinky lock module of
 * the runtime being handled. The lock lives in `<workspaceRoot>/.ploinky-box`,
 * so the workspace root is always passed; this tooling keeps no other lock
 * location. The in-place updater takes and releases it in place and never
 * renames the workspace, so no relocation, deferral or successor custody exists.
 */
export async function acquireWorkspaceCustody(module, scope, { workspaceRoot = scope.workspace } = {}) {
    const lock = await module.createMutationLockManager().acquire(scope.box, { workspaceRoot });
    let released = false;
    return {
        workspaceRoot,
        assertHeld() { requireProof(!released, 'QA_WORKSPACE_LOCK_RELEASED'); lock.assertHeld(scope.box); },
        release() { if (!released) { lock.release(); released = true; } },
    };
}

function command(program, args, options = {}) {
    const result = spawnSync(program, args, { encoding: 'utf8', timeout: 120_000,
        stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, ...options });
    requireProof(!result.error && result.status === 0, 'QA_EXTERNAL_COMMAND_FAILED');
    return result.stdout.trim();
}


/**
 * Container arguments of the source-check sandbox: the exact local Box image,
 * no network, no pull, a read-only root and repository, every capability
 * dropped, no privilege gain, and the unprivileged image user (uid 1000) mapped
 * to the invoking host user, so the sandbox reads exactly what that user reads.
 */
export function sourceSandboxArguments(directoryPath, image) {
    return ['run', '--rm', '-i', '--network=none', '--pull=never', '--read-only', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--userns=keep-id:uid=1000,gid=1000', '--user=1000:1000',
        '--pids-limit=64', '--tmpfs=/tmp:rw,nosuid,nodev,noexec,mode=1777', '--env=HOME=/tmp', '--workdir=/tmp',
        `--volume=${directoryPath}:${directoryPath}:ro`, '--entrypoint=/usr/local/bin/node', image,
        '--input-type=module', '-', directoryPath];
}

/**
 * Runs SOURCE_CHECK_SCRIPT for one repository in a throwaway rootless Podman
 * container. `sandbox` names the engine and exact image of the QA Box being
 * handled; without one, or outside rootless Podman, nothing runs.
 */
export function createSourceSandbox({ env = process.env, run = command } = {}) {
    let rootless = false;
    return (directoryPath, sandbox) => {
        const image = String(sandbox?.image || '').replace(/^sha256:/, '');
        requireProof(sandbox?.engine === 'podman' && FULL_ID.test(image), 'QA_SOURCE_SANDBOX_UNAVAILABLE');
        requireProof(SOURCE_PATH.test(directoryPath) && path.normalize(directoryPath) === directoryPath, 'QA_SOURCE_SANDBOX_PATH_INVALID');
        if (!rootless) {
            requireProof(run('podman', ['info', '--format', '{{.Host.Security.Rootless}}'], { env }) === 'true',
                'QA_SOURCE_SANDBOX_UNAVAILABLE');
            rootless = true;
        }
        const output = run('podman', sourceSandboxArguments(directoryPath, image), { env, input: SOURCE_CHECK_SCRIPT, timeout: 120_000 });
        try { return JSON.parse(output); } catch { return requireProof(false, 'QA_SOURCE_SANDBOX_FAILED'); }
    };
}

/**
 * Container arguments for one Git command on one repository the Box can write,
 * with the same isolation as the source checks. Only that repository is
 * mounted, read-only unless the command must write it; only a fetch or remote
 * query gets a network. Hooks are disabled; Box-written fsmonitor, filter and
 * other configuration can then run only inside this container.
 */
export function gitSandboxArguments(repository, image, args, { write = false, network = null, source = repository } = {}) {
    return ['run', '--rm', '-i', `--network=${network ? sandboxNetwork(network) : 'none'}`, '--pull=never', '--read-only', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--userns=keep-id:uid=1000,gid=1000', '--user=1000:1000',
        '--pids-limit=64', '--tmpfs=/tmp:rw,nosuid,nodev,noexec,mode=1777', '--env=HOME=/tmp',
        '--env=GIT_OPTIONAL_LOCKS=0', '--env=GIT_TERMINAL_PROMPT=0', '--workdir=/tmp',
        `--volume=${source}:${repository}:${write ? 'rw' : 'ro'}`, '--entrypoint=/usr/bin/git', image,
        '-c', `safe.directory=${repository}`, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
        '-c', 'core.untrackedCache=false', '-C', repository, ...args];
}

/**
 * The network of a sandboxed fetch or remote query: outbound only, never the
 * host loopback, rendered for the engine's configured rootless network.
 * Anything else fails closed.
 */
export function sandboxNetwork(kind) {
    if (kind === 'pasta') return 'pasta:--no-map-gw';
    if (kind === 'slirp4netns') return 'slirp4netns:allow_host_loopback=false';
    return requireProof(false, 'QA_SOURCE_SANDBOX_NETWORK_UNAVAILABLE');
}

/**
 * The mount source of a repository the sandbox may write: every component is
 * checked with lstat and none may be a symbolic link, so the mount is exactly
 * the resolved directory that was checked.
 */
export function writableRepositorySource(repository, fsApi = fs) {
    requireProof(path.isAbsolute(repository) && path.normalize(repository) === repository, 'QA_SOURCE_SANDBOX_PATH_INVALID');
    let current = path.parse(repository).root;
    for (const part of repository.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        const stat = fsApi.lstatSync(current);
        requireProof(stat.isDirectory() && !stat.isSymbolicLink(), 'QA_SOURCE_SANDBOX_PATH_INVALID');
    }
    const resolved = fsApi.realpathSync(repository);
    requireProof(resolved === repository, 'QA_SOURCE_SANDBOX_PATH_INVALID');
    return resolved;
}

/**
 * Runs Git commands in throwaway rootless Podman containers made from the exact
 * image of the QA Box being handled. Returns the raw spawn result, so callers
 * keep their own exit-status rules. Without a Podman Box image, or outside
 * rootless Podman, nothing runs.
 */
export function createGitSandbox({ env = process.env, spawn = spawnSync, fsApi = fs } = {}) {
    let engineInfo = null;
    return (repository, sandbox, args, { write = false, network = false, timeout = 60_000, encoding = 'utf8' } = {}) => {
        const image = String(sandbox?.image || '').replace(/^sha256:/, '');
        requireProof(sandbox?.engine === 'podman' && FULL_ID.test(image), 'QA_SOURCE_SANDBOX_UNAVAILABLE');
        requireProof(SOURCE_PATH.test(repository) && path.normalize(repository) === repository, 'QA_SOURCE_SANDBOX_PATH_INVALID');
        if (!engineInfo) {
            const info = spawn('podman', ['info', '--format', '{{.Host.Security.Rootless}} {{.Host.RootlessNetworkCmd}}'],
                { env, encoding: 'utf8', timeout: 60_000 });
            const [rootless, networkCommand = ''] = String(info.stdout || '').trim().split(/\s+/);
            requireProof(!info.error && info.status === 0 && rootless === 'true', 'QA_SOURCE_SANDBOX_UNAVAILABLE');
            engineInfo = { networkCommand };
        }
        // A networked run needs the engine's rootless network; without one it fails closed.
        if (network) sandboxNetwork(engineInfo.networkCommand);
        const source = write ? writableRepositorySource(repository, fsApi) : repository;
        return spawn('podman', gitSandboxArguments(repository, image, args,
            { write, network: network ? engineInfo.networkCommand : null, source }),
        { env, encoding, timeout, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    };
}

/** Validates one sandbox report exactly as the former host-side Git checks did. */
export function sourcePinFromReport(directoryPath, report, scope = QA_SCOPE) {
    const value = key => {
        const row = report?.[key];
        requireProof(row && row.status === 0 && typeof row.stdout === 'string', 'QA_EXTERNAL_COMMAND_FAILED');
        return row.stdout.trim();
    };
    requireProof(value('toplevel') === directoryPath && value('status') === '', 'QA_SOURCE_NOT_CLEAN');
    const commit = value('head');
    requireProof(/^[a-f0-9]{40}$/.test(commit), 'QA_SOURCE_COMMIT_INVALID');
    const origin = value('origin');
    if (directoryPath.includes('/.ploinky/agentlib/generations/')) {
        requireProof(new RegExp(`^${commit}-[a-f0-9]{12}$`).test(path.basename(directoryPath))
            && origin === path.join(scope.workspace, '.ploinky/agentlib/mirror.git'), 'QA_SOURCE_ORIGIN_INVALID');
    } else requireProof(/^https:\/\/github\.com\/AssistOS-AI\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(origin), 'QA_SOURCE_ORIGIN_INVALID');
    return { commit, branch: value('branch'), origin };
}

export function productionAdapters(scope = QA_SCOPE) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PLOINKY_|CLOUDFLARE_)/.test(key)));
    const inside = (item, source, args = [], timeout = 120_000) => command(item.engine,
        ['container', 'exec', '-i', '--user', 'podman', '--workdir', scope.workspace,
            '--env', `PLOINKY_WORKSPACE_ROOT=${scope.workspace}`, '--env', 'PLOINKY_ROUTER_HOST_PORT=8097',
            '--env', 'PLOINKY_MEDIA_HOST_PORT=7882', item.box.id, 'node', '--input-type=module', '-', ...args],
        { input: source, timeout, env });
    const sanitize = (engine, item) => {
        // Establish workspace ownership, confinement and mount admission before
        // executing any read-only verifier inside the alleged Box.
        inspectBoxIdentity(item, scope);
        const reference = item.Config?.Labels?.[LABEL + 'image-ref'] || item.ImageName;
        const bundled = item.Config?.Labels?.[LABEL + 'agentlib-mode'] === 'image';
        let proof = null;
        if (bundled || !/^[^\s]+@sha256:[a-f0-9]{64}$/.test(reference)) {
            const id = String(item.Image || '').replace(/^sha256:/, '');
            requireProof(FULL_ID.test(id), 'QA_IMAGE_NOT_PINNED');
            const images = JSON.parse(command(engine, ['image', 'inspect', id], { env }));
            requireProof(images.length === 1, 'QA_IMAGE_NOT_PINNED');
            proof = images[0];
        }
        if (bundled) {
            const id = String(item.Image || '').replace(/^sha256:/, '');
            const legacy = isLegacyImageAgentLib(item.Config.Labels);
            const commit = String(item.Config.Labels[LABEL + 'agentlib-commit'] || '');
            requireProof(!legacy || /^[a-f0-9]{40}$/.test(commit), 'QA_AGENTLIB_IMAGE_LABELS_INVALID');
            assertImageAgentLibMounts(item.Mounts);
            assertAgentLibImageIdentity(id, proof);
            const pinned = /^[^\s]+@sha256:[a-f0-9]{64}$/.test(reference) ? reference
                : (proof.RepoDigests || []).filter(value => /^docker\.io\/assistos\/ploinky-box@sha256:[a-f0-9]{64}$/.test(value)).sort()[0];
            requireProof(pinned, 'QA_IMAGE_NOT_PINNED');
            const referenceImages = JSON.parse(command(engine, ['image', 'inspect', pinned], { env }));
            requireProof(referenceImages.length === 1 && String(referenceImages[0].Id).replace(/^sha256:/, '') === id,
                'QA_AGENTLIB_IMAGE_REFERENCE_CHANGED');
            proof.verifiedImageReference = pinned;
            proof.referenceImageId = referenceImages[0].Id;
            // No workspace mounts or network are available to this immutable-image
            // probe. The image's own verifier checks the protected package layout,
            // actual modules and root ownership independently of the mutable
            // Ploinky checkout. A retired commit-labelled image checks its label.
            const sealed = ['run', '--rm', '--network=none', '--pull=never', '--read-only', '--cap-drop=ALL',
                '--security-opt=no-new-privileges', '--user=podman'];
            if (legacy) {
                proof.agentLibBundle = JSON.parse(command(engine, [...sealed,
                    '--entrypoint=/usr/local/bin/node', id, LEGACY_AGENTLIB_IMAGE_PROBE, 'verify', '--expected-commit', commit],
                { env, timeout: 60_000 }));
                if (item.State?.Running === true) {
                    proof.runtimeAgentLibBundle = JSON.parse(command(engine, ['container', 'exec', '--user', 'podman', item.Id,
                        '/usr/local/bin/node', LEGACY_AGENTLIB_IMAGE_PROBE, 'verify', '--expected-commit', commit], { env, timeout: 60_000 }));
                }
            } else {
                const probe = [AGENTLIB_IMAGE_PROBE, 'inspect', 'achillesAgentLib'];
                proof.agentLibInspection = JSON.parse(command(engine, [...sealed, '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777',
                    '--entrypoint=/usr/local/bin/node', id, ...probe], { env, timeout: 60_000 }));
                if (item.State?.Running === true) {
                    proof.runtimeAgentLibInspection = JSON.parse(command(engine, ['container', 'exec', '--user', 'podman', item.Id,
                        '/usr/local/bin/node', ...probe], { env, timeout: 60_000 }));
                }
            }
        }
        return { engine, box: sanitizeBox(item, scope, proof) };
    };
    const inspect = (engine, id) => {
        const records = JSON.parse(command(engine, ['container', 'inspect', id], { env }));
        requireProof(records.length === 1, 'QA_INSPECTION_AMBIGUOUS');
        return sanitize(engine, records[0]);
    };
    const sourceSandbox = createSourceSandbox({ env });
    // One sandbox run yields the pin and, for the runtime verifier, the upstream.
    const checkSource = (directoryPath, sandbox) => {
        directory(directoryPath);
        directory(path.join(directoryPath, '.git'));
        const report = sourceSandbox(directoryPath, sandbox);
        const upstream = report?.upstream?.status === 0 && typeof report.upstream.stdout === 'string' ? report.upstream.stdout.trim() : null;
        return { pin: sourcePinFromReport(directoryPath, report, scope), upstream };
    };
    const lockModule = runtimeRoot => import(path.join(runtimeRoot, '.runtime/ploinky/ploinky-box/locks.mjs'));
    const adapters = {
        async acquireWorkspaceLock(previous, options = {}) {
            return acquireWorkspaceCustody(await lockModule(previous), scope, options);
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
        // The Box can write these repositories, so Git never runs on them in the
        // host process; only structural lstat checks do.
        sourcePin: (directoryPath, sandbox) => checkSource(directoryPath, sandbox).pin,
        sourceCheck: checkSource,
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
                        || String(item.Name).replace(/^\//, '') === scope.box) result.push(sanitize(engine, item));
                }
            }
            return result;
        },
        // The current QA Box's AgentLib is the one its exact image supplies:
        // inspection re-verifies both copies with the image's own probe. No
        // commit is pinned; the build provenance is recorded as diagnostic.
        async verifyAgentLib(item) {
            const current = inspect(item.engine, item.box.id);
            requireProof(current.box.contract === item.box.contract && current.box.running, 'QA_BOX_CHANGED_DURING_VERIFICATION');
            const selection = assertImageOwnedAgentLib(current.box.agentLib);
            const final = inspect(item.engine, item.box.id);
            requireProof(final.box.contract === current.box.contract && final.box.running, 'QA_BOX_CHANGED_DURING_VERIFICATION');
            return selection;
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
                const active=loadActiveEdgeRoutingGeneration({workspaceRoot:${JSON.stringify(scope.workspace)}});
                const matches=expected.every(old=>states.some(row=>row.repoName===old.repo&&row.agentName===old.agent
                    &&(registry[row.containerName]?.alias||'')===old.alias&&registry[row.containerName]?.containerId!==old.oldId
                    &&(registry[row.containerName]?.profile||'default')===old.profile&&registry[row.containerName]?.auth?.mode===old.auth
                    &&(registry[row.containerName]?.runMode||'isolated')===(old.runMode||'isolated')
                    &&(old.runMode!=='devel'||registry[row.containerName]?.develRepo===old.develRepo)));
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
