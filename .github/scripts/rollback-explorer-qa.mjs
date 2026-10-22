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
// Full graph shutdown includes sequential service drains and identity checks.
export const QUIESCE_EXEC_TIMEOUT_MS = 900_000;
const FULL_ID = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
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
// Ploinky 7d8c04d0 keeps the encryption identity under .ploinky/data (12d76a76);
// earlier runtimes kept it directly under .ploinky. Present files in either
// layout are fingerprinted and absent ones are omitted.
const MASTER_KEY_FILES = ['.ploinky/data/master-key', '.ploinky/master-key'];
const AUTH_FILES = ['.env', ...MASTER_KEY_FILES, '.ploinky/data/.secrets', '.ploinky/.secrets',
    '.ploinky/data/passwords.enc', '.ploinky/passwords.enc',
    '.ploinky/data/ploinky_subject_identity_ed25519_v1.enc', '.ploinky/ploinky_subject_identity_ed25519_v1.enc'];
const GENERATED_STATE = new Set(['agents.json', 'routing.json', 'running', 'run', 'logs', 'box', 'deps',
    'container-runtime', 'graph-skill-scope.json', 'data']);
const GENERATED_DATA = new Set(['edge-routing', 'edge-publication', 'router-security']);
// Ploinky's workspace Box state directory. It is never copied between
// workspaces: a recreated workspace gets a fresh skeleton from its new lock.
const HOST_STATE_DIRECTORY = '.ploinky-box';
const isHostStateEntry = name => name === HOST_STATE_DIRECTORY || name.startsWith(HOST_STATE_DIRECTORY + '.');
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
// These reviewed files preserve existing and deliberately empty account stores.
// Changed implementations require a new review before prior-code recovery is allowed.
export const ACCOUNT_CAPABILITY = Object.freeze({
    'cli/utils/agents.js': '6999a75c2ab07ed4096b54c50d1cc8f4ce333c6dffa77d9dac711a42633b4ff6',
    'cli/utils/security/encryptedPasswordStore.js': '7b25995756f48c10eeb56a53508bd5321701977ac8f0bfdd752199136a0265a3',
    'cli/utils/security/passwordStoreLock.mjs': 'f23ec55e64bfc44d4ffe3ea37f08b441f7b1bf848c1303ea9d130f1bd934beaf',
});
// Ploinky 7d8c04d0 removed local password authentication (df976761), so the
// password-store modules and their credential seeding no longer exist; its
// agent registration is reviewed against that removal. Ploinky 581f8299 changes
// agents.js only for edge routing: same-name re-enables that drain and replace
// beside the old runtime, withdrawal on disable, the disable retry and
// replacement-policy persistence; account stores stay untouched and the
// password-store modules stay absent. Any one complete set matches; a file
// taken from one set never satisfies another.
export const ACCOUNT_CAPABILITY_SETS = Object.freeze([ACCOUNT_CAPABILITY, Object.freeze({
    'cli/utils/agents.js': '0583a4815c7ab0766d5d2a71920c78fab856f1c902d9b587e319dff964dba82b',
    'cli/utils/security/encryptedPasswordStore.js': null,
    'cli/utils/security/passwordStoreLock.mjs': null,
}), Object.freeze({
    'cli/utils/agents.js': '237abcb8d52d1fc60908c3151e71f726a8f3f2767838aa0736cb659f0fc4de0b',
    'cli/utils/security/encryptedPasswordStore.js': null,
    'cli/utils/security/passwordStoreLock.mjs': null,
})]);
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

/** `reviewedFiles` is one set of path to digest, or a list of such sets; `null` means the file must be absent. */
export function accountCapability(root, reviewedFiles = ACCOUNT_CAPABILITY_SETS) {
    const sets = Array.isArray(reviewedFiles) ? reviewedFiles : [reviewedFiles];
    return sets.some(files => Object.entries(files).every(([relative, expected]) => {
        const file = path.join(root, '.runtime/ploinky', relative), stat = present(file);
        if (expected === null) return stat === null;
        return stat?.isFile() && !stat.isSymbolicLink() && digest(fs.readFileSync(file)) === expected;
    }));
}

export function enableArguments(selection) {
    const mode = selection.runMode || 'isolated';
    const args = ['enable', 'agent', `${selection.repo}/${selection.agent}`, mode];
    if (mode === 'devel') args.push(selection.develRepo);
    args.push('--auth', selection.auth === 'local' ? 'pwd' : selection.auth);
    if (selection.alias) args.push('as', selection.alias);
    return args;
}

function assertSelection(selection) {
    requireProof(NAME.test(selection.repo) && NAME.test(selection.agent)
        && (!selection.alias || NAME.test(selection.alias))
        && ['none', 'local', 'sso', 'guest'].includes(selection.auth)
        && ['isolated', 'global', 'devel'].includes(selection.runMode || 'isolated')
        && (selection.runMode !== 'devel' || NAME.test(selection.develRepo)), 'QA_SELECTION_INVALID');
}

/**
 * The default Explorer graph the current workflow starts, used only to predict
 * the dispositions of the prior selections before anything is stopped.
 */
export const EXPECTED_DEFAULT_GRAPH = Object.freeze([
    'AchillesIDE/explorer', 'AchillesIDE/gitAgent', 'AchillesIDE/userPersistoAgent', 'AchillesIDE/emailAgent',
    'AchillesIDE/dpuAgent', 'AchillesIDE/roboTeamAgent', 'AchillesIDE/soul-gateway', 'AchillesIDE/workspaceMonitorAgent',
    'local-llms/local-llm',
]);

/**
 * Decides, without enabling anything, what happens to each prior selection
 * against the fresh registry. A selection in the fresh graph is retained, or
 * superseded when the fresh graph sets another profile, auth or run mode. One
 * that moved to another repository is renamed and one that left is absent;
 * neither is replayed. With `comparePolicy` off only identity is compared.
 */
export function classifyPriorSelections(selections, registry, { comparePolicy = true } = {}) {
    const rows = Object.values(registry || {}).filter(row => row?.type === 'agent');
    const label = (repo, agent, alias) => `${repo}/${agent}${alias ? ` as ${alias}` : ''}`;
    const dispositions = selections.map(selection => {
        assertSelection(selection);
        const alias = selection.alias || '';
        const ref = label(selection.repo, selection.agent, alias);
        const same = rows.filter(row => row.repoName === selection.repo && row.agentName === selection.agent
            && (row.alias || '') === alias);
        requireProof(same.length <= 1, 'QA_SELECTION_AMBIGUOUS');
        if (same.length) {
            const row = same[0], changes = [];
            const compare = (field, from, to) => { if (from !== to) changes.push({ field, from, to }); };
            if (comparePolicy) {
                compare('profile', selection.profile, row.profile || 'default');
                compare('auth', selection.auth, row.auth?.mode);
                compare('runMode', selection.runMode || 'isolated', row.runMode || 'isolated');
                if (selection.runMode === 'devel') compare('develRepo', selection.develRepo, row.develRepo);
            }
            return changes.length ? { ref, kind: 'superseded', changes } : { ref, kind: 'retained' };
        }
        const moved = rows.filter(row => row.agentName === selection.agent && (row.alias || '') === alias)
            .map(row => label(row.repoName, row.agentName, row.alias)).sort();
        return moved.length ? { ref, kind: 'renamed', replacement: moved.join(', ') } : { ref, kind: 'absent' };
    });
    const count = kind => dispositions.filter(item => item.kind === kind).length;
    return { dispositions, counts: { total: dispositions.length, retained: count('retained'),
        superseded: count('superseded'), renamed: count('renamed'), absent: count('absent'),
        notReplayed: count('renamed') + count('absent'), enabled: 0 } };
}

/** One log line per disposition, then the totals. */
export function describeSelectionDispositions({ dispositions, counts }, prefix = '[deploy-qa] Prior selection') {
    const lines = [];
    for (const item of dispositions) {
        if (item.kind === 'retained') lines.push(`${prefix} retained: ${item.ref}`);
        else if (item.kind === 'superseded') {
            for (const change of item.changes) {
                lines.push(`${prefix} policy superseded: ${item.ref} ${change.field} ${change.from} -> ${change.to}`);
            }
        } else if (item.kind === 'renamed') {
            lines.push(`${prefix} not replayed: ${item.ref} (renamed to ${item.replacement}; fresh graph policy applies)`);
        } else lines.push(`${prefix} not replayed: ${item.ref} (not in the fresh default graph; re-enable through Marketplace if still required)`);
    }
    lines.push(`${prefix}s: ${counts.total} total, ${counts.retained} retained, ${counts.superseded} superseded, `
        + `${counts.notReplayed} not replayed, ${counts.enabled} enabled.`);
    return lines;
}

/** The caller supplies an already admitted exact Box and pinned CLI operations. */
export async function restorePriorSelections({ selections, profile, readRegistry, enable }) {
    const restored = [];
    for (const selection of selections) {
        assertSelection(selection);
        const registry = await readRegistry();
        const matches = Object.values(registry).filter(row => row?.type === 'agent'
            && row.repoName === selection.repo && row.agentName === selection.agent && (row.alias || '') === selection.alias);
        requireProof(matches.length <= 1, 'QA_SELECTION_AMBIGUOUS');
        if (matches.length) {
            requireProof((matches[0].profile || 'default') === selection.profile && matches[0].auth?.mode === selection.auth,
                'QA_SELECTION_POLICY_CHANGED');
            requireProof((matches[0].runMode || 'isolated') === (selection.runMode || 'isolated')
                && (selection.runMode !== 'devel' || matches[0].develRepo === selection.develRepo), 'QA_SELECTION_MODE_CHANGED');
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
        && /^[a-f0-9-]{36}$/.test(String(desired.cloudflare?.tunnelId || ''))
        && desired.cloudflare.tunnelId !== '091c4096-d1c8-4dbc-bb12-0c6357431d96'
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
            && (!row.alias || NAME.test(row.alias)) && ['none', 'local', 'sso', 'guest'].includes(row.auth?.mode)
            && (!row.runMode || ['isolated', 'global', 'devel'].includes(row.runMode))
            && (row.runMode !== 'devel' || NAME.test(row.develRepo)), 'QA_AGENT_SELECTION_UNSUPPORTED');
        return { name, repo: row.repoName, agent: row.agentName, alias: row.alias || '',
            profile: row.profile || 'default', auth: row.auth.mode, oldId: row.containerId,
            runMode: row.runMode || 'isolated', ...(row.runMode === 'devel' ? { develRepo: row.develRepo } : {}) };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

function sourceDirectories(root) {
    const selected = ['.runtime/ploinky', 'AdvancedLanguageAgent', 'achillesAgentLib'];
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
    const entries = fs.readdirSync(root).filter(name => name !== '.ploinky' && !isHostStateEntry(name));
    const state = path.join(root, '.ploinky');
    for (const name of fs.readdirSync(state)) if (!GENERATED_STATE.has(name)) entries.push(path.join('.ploinky', name));
    const data = path.join(state, 'data');
    if (present(data)) for (const name of fs.readdirSync(data)) {
        if (!GENERATED_DATA.has(name)) entries.push(path.join('.ploinky/data', name));
    }
    return entries;
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
 * Acquires the QA workspace mutation lock from one imported Ploinky lock
 * module. The lock lives in `<workspaceRoot>/.ploinky-box`, so it follows the
 * workspace when the directory is renamed: the handle exposes the relocation and
 * deletion custody operations, and `successor` takes the lock of a recreated
 * workspace from the same module. With `deferIfAbsent`, an absent workspace
 * yields a deferred handle that holds nothing; the caller's outer host lock
 * serializes QA operations until the workspace exists.
 */
export async function acquireWorkspaceCustody(module, scope, { workspaceRoot = scope.workspace, deferIfAbsent = false } = {}) {
    const take = (root, requireNewSkeleton) => module.createMutationLockManager()
        .acquire(scope.box, { workspaceRoot: root, requireNewSkeleton });
    const handle = (lock, root) => {
        let released = false;
        const once = action => { requireProof(!released, 'QA_WORKSPACE_LOCK_RELEASED'); action(); released = true; };
        return {
            deferred: false, workspaceRoot: root,
            assertHeld() { requireProof(!released, 'QA_WORKSPACE_LOCK_RELEASED'); lock.assertHeld(scope.box); },
            assertHeldAt(relocatedRoot) { requireProof(!released, 'QA_WORKSPACE_LOCK_RELEASED'); lock.assertHeldAt(relocatedRoot); },
            releaseRelocated(relocatedRoot) { once(() => lock.releaseRelocated(relocatedRoot)); },
            relinquishDeleted() { once(() => lock.relinquishDeleted()); },
            release() { if (!released) { lock.release(); released = true; } },
            async successor(newRoot) { return handle(await take(newRoot, true), newRoot); },
        };
    };
    if (deferIfAbsent && !present(workspaceRoot)) {
        const refuse = () => requireProof(false, 'QA_WORKSPACE_LOCK_DEFERRED');
        return { deferred: true, workspaceRoot, release() {}, assertHeld: refuse,
            assertHeldAt: refuse, releaseRelocated: refuse, relinquishDeleted: refuse,
            async successor(newRoot) { return handle(await take(newRoot, true), newRoot); } };
    }
    return handle(await take(workspaceRoot, false), workspaceRoot);
}

/**
 * A recreated workspace holds only the fresh Box state skeleton its successor
 * lock created: `locks/` with at most that held lock, an empty `quarantine/`,
 * an empty `empty/` and, if present, an empty `tmp/`. Nothing was copied in.
 */
export function assertSkeletonOnlyHostState(root, heldLock = null) {
    const hostState = path.join(root, HOST_STATE_DIRECTORY);
    const entries = name => {
        const stat = present(path.join(hostState, name));
        requireProof(stat?.isDirectory() && !stat.isSymbolicLink(), 'QA_GENERATED_STATE_RESTORED');
        return fs.readdirSync(path.join(hostState, name));
    };
    const stat = present(hostState);
    requireProof(stat?.isDirectory() && !stat.isSymbolicLink(), 'QA_GENERATED_STATE_RESTORED');
    const names = fs.readdirSync(hostState).sort();
    requireProof(['empty', 'locks', 'quarantine'].every(name => names.includes(name))
        && names.every(name => ['empty', 'locks', 'quarantine', 'tmp'].includes(name)), 'QA_GENERATED_STATE_RESTORED');
    requireProof(entries('empty').length === 0 && entries('quarantine').length === 0
        && (!names.includes('tmp') || entries('tmp').length === 0), 'QA_GENERATED_STATE_RESTORED');
    const locks = entries('locks');
    requireProof(locks.length === 0 || (locks.length === 1 && locks[0] === 'workspace.lock' && heldLock), 'QA_GENERATED_STATE_RESTORED');
    if (locks.length) heldLock.assertHeld();
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
    // Source checks run in a sandbox made from the exact image of the Box being
    // captured or recovered; the image is already pinned and present locally.
    const sandboxOf = item => item ? { engine: item.engine, image: item.box.image } : null;
    const pins = (root, sandbox) => sourceDirectories(root)
        .map(relative => ({ relative, ...adapters.sourcePin(path.join(root, relative), sandbox) }));
    const matches = (actual, expected, code) => requireProof(JSON.stringify(actual) === JSON.stringify(expected), code);
    const inventory = () => adapters.boxes();

    /** The proofs capture and its read-only preview share; nothing is written. */
    function survey(backup) {
        const stat = present(scope.workspace);
        if (stat) directory(scope.workspace);
        const allBoxes = inventory();
        requireProof(allBoxes.every(item => item.box.name === scope.box
            || (item.box.running === false && item.box.name.startsWith(scope.box + '-'))), 'QA_UNSELECTED_ACTIVE_BOX');
        const boxes = allBoxes.filter(item => item.box.name === scope.box);
        requireProof(boxes.length <= 1, 'QA_BOX_AMBIGUOUS');
        const predecessor = boxes[0] || null;
        requireProof(!predecessor || stat, 'QA_PREDECESSOR_WORKSPACE_MISSING');
        const sources = stat ? pins(scope.workspace, sandboxOf(predecessor)) : [];
        if (predecessor) requireProof(sources.some(source => source.relative === '.runtime/ploinky')
            && sources.some(source => source.relative === '.ploinky/repos/AchillesIDE'), 'QA_SOURCES_INCOMPLETE');
        if (predecessor) for (const destination of ['/opt/ploinky', ...(predecessor.box.agentLib?.mode === 'image' ? [] : [AGENTLIB_IMAGE_PATH])]) {
            const mount = predecessor.box.mounts.find(item => item.Destination === destination);
            requireProof(sources.some(source => path.join(scope.workspace, source.relative) === mount.Source), 'QA_MOUNTED_SOURCE_NOT_CAPTURED');
        }
        // An image predecessor's AgentLib authority is its immutable image,
        // already verified with that image's own probe when it was inspected.
        const authority = { version: 1, workspace: scope.workspace, backup, machineId: adapters.machineId(),
            createdAt: new Date().toISOString(), workspaceIdentity: stat ? identity(stat) : null,
            predecessor, sources, auth: stat ? secretIdentities(scope.workspace) : [],
            desiredDigest: predecessor ? validateDesired(scope.workspace) : null,
            agents: stat ? selectedAgents(scope.workspace) : [],
            rollbackSupported: !predecessor || adapters.accountCapability(scope.workspace),
        };
        authority.rollbackCode = authority.rollbackSupported ? null : 'QA_PRIOR_CREDENTIAL_RUNTIME_UNSUPPORTED';
        if (predecessor) {
            const keys = authority.auth.filter(file => MASTER_KEY_FILES.includes(file.relative));
            requireProof(keys.length > 0, 'QA_MASTER_KEY_MISSING');
            requireProof(keys.every(file => file.sha256 === keys[0].sha256), 'QA_MASTER_KEY_AMBIGUOUS');
        }
        return authority;
    }

    function capture(backup) {
        adapters.assertHost();
        const files = paths(backup);
        requireProof(fs.readdirSync(backup).length === 0, 'QA_BACKUP_NOT_EMPTY');
        const authority = survey(backup);
        writeNew(files.authority, authority);
        fs.writeFileSync(path.join(backup, 'prior-containers.txt'), authority.predecessor
            ? `${authority.predecessor.engine}|${authority.predecessor.box.id}|${scope.box}\n` : '', { flag: 'wx', mode: 0o600 });
        return { result: 'captured', predecessorId: authority.predecessor?.box.id || null, sources: authority.sources.length,
            rollbackSupported: authority.rollbackSupported, rollbackCode: authority.rollbackCode };
    }

    /** Applies every proof of capture, with no backup, and writes nothing. */
    function previewCapture() {
        adapters.assertHost();
        const authority = survey(null);
        return { result: 'previewed', predecessorId: authority.predecessor?.box.id || null, sources: authority.sources,
            agents: authority.agents, rollbackSupported: authority.rollbackSupported, rollbackCode: authority.rollbackCode };
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
        matches(pins(previous, sandboxOf(authority.predecessor)), authority.sources, 'QA_PREVIOUS_SOURCES_CHANGED');
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
        // The workspace lock moves with the renamed workspace, so it is handed
        // over to the recreated workspace and then released at its new path.
        const initialLock = await adapters.acquireWorkspaceLock(selected.previous,
            { workspaceRoot: scope.workspace, deferIfAbsent: true });
        let workspaceLock = initialLock, relocatedLock = null, relocatedRoot = null;
        const releaseLocks = () => {
            const relocated = relocatedLock; relocatedLock = null;
            try { workspaceLock.release(); } finally { if (relocated) relocated.releaseRelocated(relocatedRoot); }
        };
        try {
            selected = plan(backup, currentId);
            // A deferred lock is valid only while the workspace stays absent.
            requireProof(!initialLock.deferred || selected.targetIdentity === null, 'QA_CURRENT_WORKSPACE_CHANGED');
        } catch (error) { releaseLocks(); throw error; }
        const { files, authority } = selected;
        const sandbox = sandboxOf(authority.predecessor);
        const receipt = { version: 1, result: 'failed', phase: 'admitted', startedAt: new Date().toISOString(),
            predecessorId: authority.predecessor.box.id, failedId: selected.current?.box.id || null,
            backup, preservedPrevious: files.previous, failedWorkspace: files.failed, recoveryBoxId: null };
        try { writeNew(files.journal, receipt); }
        catch (error) { releaseLocks(); throw error; }
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
            let renamedTo = null;
            if (selected.previous === scope.workspace) renamedTo = files.previous;
            else if (present(scope.workspace)) renamedTo = files.failed;
            if (renamedTo) {
                fs.renameSync(scope.workspace, renamedTo);
                if (!initialLock.deferred) {
                    relocatedLock = initialLock; relocatedRoot = renamedTo;
                    workspaceLock = { release() {} };
                    checkpoint('workspace-relocated');
                }
            }
            matches(identity(directory(files.previous)), authority.workspaceIdentity, 'QA_PREVIOUS_WORKSPACE_CHANGED');
            matches(pins(files.previous, sandbox), authority.sources, 'QA_PREVIOUS_SOURCES_CHANGED');
            matches(secretIdentities(files.previous), authority.auth, 'QA_PREVIOUS_AUTH_CHANGED');
            checkpoint('copying-durable-state');
            fs.mkdirSync(scope.workspace, { mode: 0o700 });
            // L1 must still be ours at the renamed path before L2 is taken on the
            // recreated workspace with a fresh skeleton; only then is L1 released
            // where it now lives.
            if (relocatedLock) relocatedLock.assertHeldAt(relocatedRoot);
            workspaceLock = await initialLock.successor(scope.workspace);
            checkpoint('replacement-lock-acquired');
            if (relocatedLock) {
                const relocated = relocatedLock; relocatedLock = null;
                relocated.releaseRelocated(relocatedRoot);
                checkpoint('previous-lock-released');
            }
            const copy = relative => {
                const from = path.join(files.previous, relative), to = path.join(scope.workspace, relative);
                if (present(from)) adapters.copy(from, to);
            };
            fs.mkdirSync(path.join(scope.workspace, '.ploinky'), { mode: 0o700 });
            for (const relative of durableEntries(files.previous)) copy(relative);
            matches(secretIdentities(scope.workspace), authority.auth, 'QA_RESTORED_AUTH_CHANGED');
            matches(pins(scope.workspace, sandbox), authority.sources, 'QA_RESTORED_SOURCES_CHANGED');
            requireProof(validateDesired(scope.workspace) === authority.desiredDigest, 'QA_RESTORED_INTENT_CHANGED');
            for (const relative of ['agents.json', 'running', 'run', 'box', 'data/edge-routing', 'data/edge-publication', 'data/router-security']) {
                requireProof(!present(path.join(scope.workspace, '.ploinky', relative)), 'QA_GENERATED_STATE_RESTORED');
            }
            assertSkeletonOnlyHostState(scope.workspace, workspaceLock);
            checkpoint('preparing-fresh-box');
            workspaceLock.release();
            const fresh = await adapters.prepare(authority);
            requireProof(FULL_ID.test(fresh.box.id) && ![receipt.predecessorId, receipt.failedId].includes(fresh.box.id)
                && fresh.box.name === scope.box && fresh.box.image === authority.predecessor.box.image
                && fresh.box.running, 'QA_RECOVERY_BOX_INVALID');
            if (authority.predecessor.box.agentLib?.mode === 'image') {
                matches(fresh.box.agentLib, authority.predecessor.box.agentLib, 'QA_RECOVERY_AGENTLIB_CHANGED');
            }
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
            matches(pins(scope.workspace, sandbox), authority.sources, 'QA_RECOVERY_SOURCES_CHANGED');
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
            releaseLocks();
        }
    }
    return { capture, previewCapture, plan, execute };
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
        accountCapability,
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
            const receipt = JSON.parse(inside(item, source, [], QUIESCE_EXEC_TIMEOUT_MS));
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
                initializeFreshEdgeRoutingSources({workspaceRoot:${JSON.stringify(scope.workspace)}});
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
                readRegistry: () => JSON.parse(inside(item, `import fs from 'node:fs'; process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(${JSON.stringify(path.join(scope.workspace, '.ploinky/agents.json'))},'utf8'))));`)),
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
