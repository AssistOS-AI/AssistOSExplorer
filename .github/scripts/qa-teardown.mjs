#!/usr/bin/env node
// Admin-side Explorer QA teardown for the deploy and destroy workflows. It
// imports only Node built-ins: the destroy host upload carries just this file,
// qa-teardown-privileged.mjs and quiesce-explorer-qa.mjs. Every command prints
// exactly one JSON line on stdout and exits 0 on success or 1 on any failure
// (75 comes only from the caller's `flock`).
//
//   route --lock-held                         read-only deployment route (contract 3 r2)
//   plan --scope S --mode M [--lock-held]     read-only teardown plan with its digest and capacity inputs
//   mark --operation update|rebuild --dispatch <ref>@<sha> --lock-held
//                                             durable install marker, the first mutation of a deploy
//   execute --scope S --mode M --quiesce fatal|warn|skip --plan-digest D --lock-held
//                                             quiesce, stop, remove QA containers, images, volumes, then the
//                                             privileged workspace reduction or deletion (contract 4 r2)
//   stash-restore --lock-held                 restore the parked access policy, then remove the stash
//   stash-clear --lock-held                   remove the parked access policy
//   complete --lock-held                      remove the marker once the new exact Box runs
//   protected-snapshot                        identities of every non-QA container, its image and volume
//
// Only QA-owned resources are touched: containers and volumes labelled with
// the QA path hash or carrying the exact QA Box name, and images that only
// removed QA containers used. Workspace files are deleted only by the root
// program, which proves the keep-set first.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Literal copies of rollback-explorer-qa.mjs `QA_SCOPE` and `QUIESCE_EXEC_TIMEOUT_MS`; a test compares them.
export const QA_SCOPE = Object.freeze({
    workspace: '/home/admin/explorerQaWorkspace',
    backups: '/home/admin/.qa-deployment-backups',
    lock: '/home/admin/.qa-deployment-operation.lock',
    box: 'ploinky-box-explorerqaworkspace-7a31ab7775eb',
    hash: '7a31ab7775eb',
    state: '/home/admin/.qa-deployment-state',
});
export const QUIESCE_EXEC_TIMEOUT_MS = 900_000;
// A workspace reduction of ~12 GB must fit inside the job, never inside a short command timeout.
export const PRIVILEGED_TIMEOUT_MS = 2_700_000;
// Contract 7 r2: free + reclaimable >= 16 GiB + pullBytes; 2 GiB when there is no QA image to measure.
export const MINIMUM_FREE_BYTES = 16 * 1024 ** 3;
export const DEFAULT_PULL_BYTES = 2 * 1024 ** 3;
// Keep this list literal; the privileged module has its own copy and a test compares them.
export const AUTH_FILES = Object.freeze(['.env', '.ploinky/data/master-key', '.ploinky/master-key',
    '.ploinky/data/.secrets', '.ploinky/.secrets', '.ploinky/data/passwords.enc', '.ploinky/passwords.enc',
    '.ploinky/data/ploinky_subject_identity_ed25519_v1.enc', '.ploinky/ploinky_subject_identity_ed25519_v1.enc']);
export const MARKER_NAME = 'install-pending.json';
export const STASH_NAME = 'router-security';
export const MARKER_OPERATIONS = Object.freeze(['update', 'rebuild', 'destroy-keep']);
export const TEARDOWN_SCOPES = Object.freeze(['rebuild', 'fresh', 'destroy']);
export const TEARDOWN_MODES = Object.freeze(['keep-data', 'delete-data']);
export const QUIESCE_MODES = Object.freeze(['fatal', 'warn', 'skip']);
// Contract 8: a fresh pull may move this tag, so the protected snapshot leaves it out.
export const PROTECTED_EXCLUDED_TAGS = Object.freeze(['docker.io/assistos/ploinky-box:latest', 'assistos/ploinky-box:latest']);

const ENGINES = ['podman', 'docker'];
const FULL_ID = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DISPATCH = /^[A-Za-z0-9._/+-]{1,255}@[a-f0-9]{40}$/;
const CREATED_AT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/;
const PATH_HASH_LABEL = 'io.assistos.ploinky-box.path-hash';
const ROLE_LABEL = 'io.assistos.ploinky-box.role';
const QA_BOX_IMAGE = /^(?:docker\.io\/)?assistos\/ploinky-box[:@]/;
const MARKER_KEYS = new Set(['version', 'operation', 'createdAt', 'dispatch', 'images']);
const MARKER_LIMIT = 64 * 1024;
const MARKER_TEMPORARY = /^install-pending\.json\.tmp-[0-9]+-[a-f0-9]{8}$/;

const safeCode = (error, fallback) => /^QA_[A-Z_]+$/.test(error?.code || '') ? error.code : fallback;
const present = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const realDirectory = stat => Boolean(stat && stat.isDirectory() && !stat.isSymbolicLink());
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const stripId = value => String(value || '').replace(/^sha256:/, '');
const sortBy = key => (left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;

function prove(condition, code, extra = {}) {
    if (!condition) throw Object.assign(new Error(code), { code, ...extra });
}

export const legacyBoxName = (scope, name) => name.startsWith(scope.box + '-')
    && /^(?:rollback|failed)-redeploy-[A-Za-z0-9]{8}$/.test(name.slice(scope.box.length + 1));

/** The light container listing; anything malformed is an engine probe failure. */
function listContainers(adapters, prefix) {
    let containers;
    try { containers = adapters.containers(); } catch { prove(false, `${prefix}_ENGINE_PROBE_FAILED`); }
    prove(Array.isArray(containers) && containers.every(item => item && ENGINES.includes(item.engine)
        && FULL_ID.test(item.id || '') && typeof item.name === 'string' && typeof item.running === 'boolean'
        && FULL_ID.test(item.image || '') && item.labels !== null && typeof item.labels === 'object'),
    `${prefix}_ENGINE_PROBE_FAILED`);
    return containers;
}

function listVolumes(adapters, prefix) {
    let volumes;
    try { volumes = adapters.volumes(); } catch { prove(false, `${prefix}_ENGINE_PROBE_FAILED`); }
    prove(Array.isArray(volumes) && volumes.every(item => item && ENGINES.includes(item.engine) && typeof item.name === 'string'
        && item.name && item.labels !== null && typeof item.labels === 'object'), `${prefix}_ENGINE_PROBE_FAILED`);
    return volumes;
}

function listImages(adapters, prefix) {
    let images;
    try { images = adapters.images(); } catch { prove(false, `${prefix}_ENGINE_PROBE_FAILED`); }
    prove(Array.isArray(images) && images.every(item => item && ENGINES.includes(item.engine) && FULL_ID.test(item.id || '')
        && Array.isArray(item.tags) && item.tags.every(tag => typeof tag === 'string')
        && Array.isArray(item.digests) && item.digests.every(tag => typeof tag === 'string')
        && Number.isSafeInteger(item.size) && item.size >= 0), `${prefix}_ENGINE_PROBE_FAILED`);
    return images;
}

/**
 * QA containers: the QA path-hash label, the exact Box name, or a name with
 * that prefix. A QA-named container without the QA label and `box` role is an
 * identity conflict; a labelled one with another name is an unknown QA container.
 */
export function classifyContainers(containers, scope = QA_SCOPE) {
    const result = { exact: [], legacy: [], unknown: [], conflicts: [] };
    for (const item of containers) {
        const labelled = item.labels[PATH_HASH_LABEL] === scope.hash;
        const named = item.name === scope.box || item.name.startsWith(scope.box + '-');
        if (!labelled && !named) continue;
        if (named && (!labelled || item.labels[ROLE_LABEL] !== 'box')) result.conflicts.push(item);
        else if (item.name === scope.box) result.exact.push(item);
        else if (legacyBoxName(scope, item.name)) result.legacy.push(item);
        else result.unknown.push(item);
    }
    return result;
}

export const qaVolumes = (volumes, scope = QA_SCOPE) => volumes.filter(item => item.labels[PATH_HASH_LABEL] === scope.hash
    || item.name === scope.box || item.name.startsWith(scope.box + '-'));

export function validMarker(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).every(key => MARKER_KEYS.has(key)) && value.version === 1
        && MARKER_OPERATIONS.includes(value.operation) && typeof value.createdAt === 'string' && CREATED_AT.test(value.createdAt)
        && (value.dispatch === null || (typeof value.dispatch === 'string' && DISPATCH.test(value.dispatch)))
        && (value.images === undefined || (Array.isArray(value.images) && value.images.every(item => item
            && Object.keys(item).sort().join(',') === 'engine,id' && ENGINES.includes(item.engine) && FULL_ID.test(item.id)))));
}

/** The state directory, the marker and the stash, read as the admin. */
export function readState(adapters, scope, prefix = 'QA_TEARDOWN') {
    const uid = adapters.getuid();
    const stat = present(scope.state);
    if (!stat) return { exists: false, marker: null, stash: false };
    prove(realDirectory(stat) && stat.uid === uid && (stat.mode & 0o077) === 0 && fs.realpathSync(scope.state) === scope.state,
        `${prefix}_STATE_INVALID`);
    const markerFile = path.join(scope.state, MARKER_NAME);
    const markerStat = present(markerFile);
    let marker = null;
    if (markerStat) {
        // A crash between the link and the unlink of `writeMarkerOnce` leaves the marker with a second
        // name: exactly one marker temporary on the same inode. That state is read as the marker, and
        // every mutating command removes the temporary first (`healMarkerTemporaries`).
        const twins = markerStat.nlink === 2 ? fs.readdirSync(scope.state).filter(name => MARKER_TEMPORARY.test(name))
            .filter(name => {
                const twin = present(path.join(scope.state, name));
                return twin?.isFile() && !twin.isSymbolicLink() && twin.dev === markerStat.dev && twin.ino === markerStat.ino;
            }) : [];
        prove(markerStat.isFile() && !markerStat.isSymbolicLink() && (markerStat.nlink === 1 || twins.length === 1)
            && markerStat.uid === uid && markerStat.size <= MARKER_LIMIT, `${prefix}_MARKER_INVALID`);
        try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch { marker = null; }
        prove(validMarker(marker), `${prefix}_MARKER_INVALID`);
    }
    const stash = present(path.join(scope.state, STASH_NAME));
    prove(!stash || realDirectory(stash), `${prefix}_STATE_INVALID`);
    return { exists: true, marker, stash: Boolean(stash) };
}

function workspaceKind(adapters, scope) {
    const stat = present(scope.workspace);
    if (!stat) return 'absent';
    return realDirectory(stat) && stat.uid === adapters.getuid() && fs.realpathSync(scope.workspace) === scope.workspace
        ? 'directory' : 'other';
}

const markerSummary = marker => marker ? { operation: marker.operation } : null;
const exactSummary = item => item ? { engine: item.engine, id: item.id, running: item.running } : null;
const legacySummary = items => items.map(item => ({ engine: item.engine, id: item.id, name: item.name }));

function assertLock(adapters) {
    prove(adapters.lockHeld() === true, 'QA_TEARDOWN_HOST_LOCK_REQUIRED');
}

/** Contract 3 r2: the read-only deployment route taken under the host lock. */
export function routeDeployment(adapters, scope = QA_SCOPE) {
    adapters.assertHost();
    assertLock(adapters);
    const state = readState(adapters, scope, 'QA_ROUTE');
    const workspace = workspaceKind(adapters, scope);
    const containers = listContainers(adapters, 'QA_ROUTE');
    const volumes = qaVolumes(listVolumes(adapters, 'QA_ROUTE'), scope);
    const qa = classifyContainers(containers, scope);
    // R8
    prove(workspace !== 'other', 'QA_ROUTE_WORKSPACE_INVALID');
    // R7
    prove(qa.conflicts.length === 0, 'QA_ROUTE_IDENTITY_CONFLICT');
    prove(qa.exact.length <= 1, 'QA_ROUTE_EXACT_AMBIGUOUS');
    prove(qa.unknown.length === 0, 'QA_ROUTE_UNKNOWN_QA_CONTAINER');
    prove(!qa.legacy.some(item => item.running), 'QA_ROUTE_LEGACY_BOX_RUNNING');
    prove(volumes.length === 0, 'QA_ROUTE_QA_VOLUME');
    const exact = qa.exact[0] || null;
    const routed = (route, reason) => ({ result: 'routed', route, reason, marker: markerSummary(state.marker),
        stash: state.stash, exact: exactSummary(exact), legacy: legacySummary(qa.legacy) });
    if (workspace === 'absent') {
        // R2, R1b, R1
        prove(!exact && qa.legacy.length === 0, 'QA_ROUTE_CONTAINERS_WITHOUT_WORKSPACE');
        prove(!state.stash, 'QA_ROUTE_STASH_WITHOUT_WORKSPACE');
        return routed('fresh', 'workspace-absent');
    }
    // R10
    prove(!state.stash || state.marker, 'QA_ROUTE_STALE_POLICY_STASH');
    // R3
    if (!exact) return routed('fresh', 'workspace-without-box');
    // R4, R5, R6
    if (exact.running && !state.marker) return routed('select', 'exact-box-running');
    if (exact.running) return routed('rebuild', 'install-marker-present');
    return routed('rebuild', 'exact-box-stopped');
}

/** The containers and volumes a scope removes, or the refusal (contract 4 r2 table). */
export function containerPlan(containers, volumes, teardownScope, mode, scope = QA_SCOPE) {
    const qa = classifyContainers(containers, scope);
    const qaVolumeList = qaVolumes(volumes, scope);
    prove(qa.conflicts.length === 0, 'QA_TEARDOWN_IDENTITY_CONFLICT');
    prove(qa.exact.length <= 1, 'QA_TEARDOWN_EXACT_AMBIGUOUS');
    if (teardownScope !== 'destroy') {
        prove(qa.unknown.length === 0, 'QA_TEARDOWN_UNKNOWN_QA_CONTAINER');
        prove(!qa.legacy.some(item => item.running), 'QA_TEARDOWN_LEGACY_BOX_RUNNING');
        if (teardownScope === 'rebuild') prove(qa.exact.length === 1, 'QA_TEARDOWN_EXACT_BOX_REQUIRED');
        else prove(qa.exact.length === 0, 'QA_TEARDOWN_EXACT_BOX_PRESENT');
    }
    prove(qaVolumeList.length === 0 || (teardownScope === 'destroy' && mode === 'delete-data'), 'QA_TEARDOWN_QA_VOLUME');
    return { exact: qa.exact[0] || null, remove: [...qa.exact, ...qa.legacy, ...qa.unknown],
        volumes: qaVolumeList.sort(sortBy(item => `${item.engine}|${item.name}`)) };
}

/**
 * Images (contract 4 r2 step 4 with N1): the candidates are the images of the
 * QA containers this run removes plus those recorded in the marker. A
 * candidate still used by a container that stays is retained, as is every
 * other `ploinky-box` image in the store.
 */
export function imagePlan(containers, images, removing, marker) {
    const key = item => `${item.engine}|${item.id}`;
    const candidates = new Map();
    for (const item of removing) candidates.set(`${item.engine}|${item.image}`, { engine: item.engine, id: item.image });
    for (const item of marker?.images || []) candidates.set(key(item), { engine: item.engine, id: item.id });
    const removingIds = new Set(removing.map(key));
    const stays = containers.filter(item => !removingIds.has(key(item)));
    const store = new Map(images.map(item => [key(item), item]));
    const remove = [], retained = [];
    for (const candidate of [...candidates.values()].sort(sortBy(key))) {
        const image = store.get(key(candidate));
        if (!image) continue;
        if (stays.some(item => item.engine === candidate.engine && item.image === candidate.id)) {
            retained.push({ engine: image.engine, id: image.id, tags: [...image.tags].sort(), reason: 'retained-in-use' });
        } else remove.push({ engine: image.engine, id: image.id, tags: [...image.tags].sort(), size: image.size });
    }
    for (const image of [...images].sort(sortBy(key))) {
        if (candidates.has(key(image))) continue;
        if ([...image.tags, ...image.digests].some(reference => QA_BOX_IMAGE.test(reference))) {
            retained.push({ engine: image.engine, id: image.id, tags: [...image.tags].sort(), reason: 'foreign-ploinky-box-image-retained' });
        }
    }
    return { candidates: [...candidates.values()].sort(sortBy(key)), remove, retained };
}

/** The digest `execute --plan-digest` binds: the scope, mode, containers, volumes and image candidates. */
export function teardownDigest(teardownScope, mode, plan, images) {
    return `sha256:${sha256(JSON.stringify({ version: 1, scope: teardownScope, mode,
        containers: plan.remove.map(item => ({ engine: item.engine, id: item.id, name: item.name })),
        volumes: plan.volumes.map(item => ({ engine: item.engine, name: item.name })),
        images: images.candidates }))}`;
}

/** Strict parse of the privileged program's single JSON line. */
export function parsePrivilegedOutput(run, operation) {
    const lines = String(run?.stdout ?? '').split('\n').filter(line => line !== '');
    let value = null;
    if (lines.length === 1) { try { value = JSON.parse(lines[0]); } catch { value = null; } }
    if (!run || run.error || run.status !== 0) {
        const code = /^QA_TEARDOWN_[A-Z_]+$/.test(value?.code || '') ? value.code : 'QA_TEARDOWN_PRIVILEGED_UNAVAILABLE';
        prove(false, code, { privileged: { operation, code, ...(Array.isArray(value?.deleted) ? { deleted: value.deleted } : {}),
            ...(Array.isArray(value?.removed) ? { removed: value.removed } : {}),
            ...(Array.isArray(value?.retired) ? { retired: value.retired } : {}) } });
    }
    const expected = { 'plan-workspace': ['planned'], 'reduce-workspace': ['reduced'], 'stash-policy': ['stashed', 'stash-kept', 'no-policy'],
        'stash-restore': ['restored', 'no-stash'], 'stash-clear': ['cleared'], 'delete-data': ['deleted'],
        'finish-deletions': ['finished'], 'plan-legacy-backups': ['planned'], 'remove-legacy-backups': ['pruned'] }[operation];
    prove(value && typeof value === 'object' && expected?.includes(value.result), 'QA_TEARDOWN_PRIVILEGED_OUTPUT_INVALID');
    if (operation === 'plan-workspace' || operation === 'reduce-workspace') {
        prove(DIGEST.test(value.digest || '') && Array.isArray(value.identity)
            && value.identity.every(item => AUTH_FILES.includes(item?.relative) && /^[a-f0-9]{64}$/.test(item.sha256 || ''))
            && value.keep && DIGEST.test(value.keep.digest || ''), 'QA_TEARDOWN_PRIVILEGED_OUTPUT_INVALID');
    }
    return value;
}

function privileged(adapters, operation, flags = []) {
    const run = adapters.runPrivileged([operation, ...flags, '--owner', String(adapters.getuid())]);
    return parsePrivilegedOutput(run, operation);
}

/** Read-only plan (contract 5 r2 step 9 and contract 6 r2 step 4) with the capacity inputs of contract 7 r2. */
export function planTeardown(adapters, { teardownScope, mode, lockHeld = false }, scope = QA_SCOPE) {
    adapters.assertHost();
    if (lockHeld) assertLock(adapters);
    const state = readState(adapters, scope);
    const containers = listContainers(adapters, 'QA_TEARDOWN');
    const volumes = listVolumes(adapters, 'QA_TEARDOWN');
    const images = listImages(adapters, 'QA_TEARDOWN');
    const plan = containerPlan(containers, volumes, teardownScope, mode, scope);
    const imageDecision = imagePlan(containers, images, plan.remove, state.marker);
    const workspace = privileged(adapters, 'plan-workspace', ['--scope', teardownScope, '--mode', mode, '--measure']);
    // A destroy proves its legacy-backup prune read-only here, so a refusal never fires after the teardown.
    const legacyBackups = teardownScope === 'destroy' ? privileged(adapters, 'plan-legacy-backups') : null;
    const imageBytes = imageDecision.remove.reduce((sum, item) => sum + item.size, 0);
    const exactImage = plan.exact ? images.find(item => item.engine === plan.exact.engine && item.id === plan.exact.image) : null;
    const pullBytes = exactImage ? exactImage.size : DEFAULT_PULL_BYTES;
    const freeBytes = adapters.freeBytes();
    prove(Number.isSafeInteger(freeBytes) && freeBytes >= 0 && Number.isSafeInteger(workspace.reclaimableBytes),
        'QA_TEARDOWN_CAPACITY_UNMEASURED');
    const reclaimableBytes = workspace.reclaimableBytes + imageBytes;
    const requiredBytes = MINIMUM_FREE_BYTES + pullBytes;
    return { result: 'planned', scope: teardownScope, mode,
        containers: plan.remove.map(item => ({ engine: item.engine, id: item.id, name: item.name, running: item.running, image: item.image })),
        volumes: plan.volumes.map(item => ({ engine: item.engine, name: item.name })),
        images: { remove: imageDecision.remove, retained: imageDecision.retained },
        workspace, legacyBackups: legacyBackups ? { remove: legacyBackups.remove, replayTombstones: legacyBackups.replayTombstones,
            retained: legacyBackups.retained, retainedSiblings: legacyBackups.retainedSiblings, unrecognized: legacyBackups.unrecognized } : null,
        marker: markerSummary(state.marker), stash: state.stash,
        capacity: { freeBytes, reclaimableBytes, workspaceReclaimableBytes: workspace.reclaimableBytes, imageReclaimableBytes: imageBytes,
            pullBytes, minimumFreeBytes: MINIMUM_FREE_BYTES, requiredBytes, sufficient: freeBytes + reclaimableBytes >= requiredBytes },
        digest: teardownDigest(teardownScope, mode, plan, imageDecision) };
}

/**
 * Removes leftover marker temporaries of an interrupted marker write, before
 * anything is validated: an unlinked temporary, or the second name a crash
 * between `linkSync` and `unlinkSync` left on the marker. They are the admin's
 * own regular files in the admin's private state directory.
 */
export function healMarkerTemporaries(adapters, scope) {
    const stat = present(scope.state);
    if (!stat) return [];
    prove(realDirectory(stat) && stat.uid === adapters.getuid() && (stat.mode & 0o077) === 0
        && fs.realpathSync(scope.state) === scope.state, 'QA_TEARDOWN_STATE_INVALID');
    const removed = [];
    for (const name of fs.readdirSync(scope.state).sort()) {
        if (!MARKER_TEMPORARY.test(name)) continue;
        const file = path.join(scope.state, name);
        const entry = present(file);
        if (!entry?.isFile() || entry.isSymbolicLink() || entry.uid !== adapters.getuid()) continue;
        fs.unlinkSync(file);
        removed.push(name);
    }
    return removed;
}

function ensureStateDirectory(adapters, scope) {
    if (!present(scope.state)) fs.mkdirSync(scope.state, { mode: 0o700 });
    healMarkerTemporaries(adapters, scope);
    return readState(adapters, scope);
}

const temporaryMarker = scope => path.join(scope.state, `${MARKER_NAME}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);

/** Creates the marker once; an existing marker is kept. Returns the marker in force. */
function writeMarkerOnce(adapters, scope, value) {
    const state = ensureStateDirectory(adapters, scope);
    if (state.marker) return { existing: true, marker: state.marker };
    prove(validMarker(value), 'QA_TEARDOWN_MARKER_INVALID');
    const temporary = temporaryMarker(scope);
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temporary, path.join(scope.state, MARKER_NAME)); }
    catch (error) {
        fs.unlinkSync(temporary);
        if (error.code !== 'EEXIST') throw error;
        return { existing: true, marker: readState(adapters, scope).marker };
    }
    fs.unlinkSync(temporary);
    return { existing: false, marker: readState(adapters, scope).marker };
}

/** N1: the candidate image IDs are recorded in the marker before the first container removal. */
function recordMarkerImages(adapters, scope, candidates) {
    const { marker } = readState(adapters, scope);
    if (!marker || candidates.length === 0) return marker;
    const key = item => `${item.engine}|${item.id}`;
    const merged = new Map((marker.images || []).map(item => [key(item), item]));
    for (const item of candidates) merged.set(key(item), { engine: item.engine, id: item.id });
    const value = { ...marker, images: [...merged.values()].sort(sortBy(key)) };
    if (JSON.stringify(value.images) === JSON.stringify(marker.images || null)) return marker;
    const temporary = temporaryMarker(scope);
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path.join(scope.state, MARKER_NAME));
    return readState(adapters, scope).marker;
}

/** Contract 2 r2: the deploy's first mutation. */
export function markInstall(adapters, { operation, dispatch }, scope = QA_SCOPE) {
    prove(['update', 'rebuild'].includes(operation) && DISPATCH.test(dispatch || ''), 'QA_TEARDOWN_USAGE_INVALID');
    adapters.assertHost();
    assertLock(adapters);
    const { existing, marker } = writeMarkerOnce(adapters, scope, { version: 1, operation,
        createdAt: adapters.now(), dispatch });
    return { result: 'marked', existing, marker };
}

const sameContainer = (left, right) => left.engine === right.engine && left.id === right.id && left.name === right.name
    && JSON.stringify(Object.entries(left.labels).sort()) === JSON.stringify(Object.entries(right.labels).sort());

function quiesceReceipt(value) {
    if (!value || typeof value !== 'object') return { result: 'failed', code: 'QA_TEARDOWN_QUIESCE_EXEC_FAILED' };
    return { result: typeof value.result === 'string' ? value.result.slice(0, 64) : 'failed',
        ...(typeof value.phase === 'string' ? { phase: value.phase.slice(0, 64) } : {}),
        ...(/^QA_[A-Z_]+$/.test(value.code || '') ? { code: value.code } : {}) };
}

function validateExecuteUsage({ teardownScope, mode, quiesce, planDigest }) {
    prove(TEARDOWN_SCOPES.includes(teardownScope) && TEARDOWN_MODES.includes(mode) && QUIESCE_MODES.includes(quiesce)
        && DIGEST.test(planDigest || ''), 'QA_TEARDOWN_USAGE_INVALID');
    // Decision D2: a keep-data destroy quiesces or stops nothing; a delete-data destroy skips the quiesce.
    if (teardownScope === 'destroy') {
        prove(mode === 'keep-data' ? quiesce === 'fatal' : quiesce === 'skip', 'QA_TEARDOWN_USAGE_INVALID');
    } else prove(mode === 'keep-data', 'QA_TEARDOWN_USAGE_INVALID');
}

/** Contract 4 r2. Returns the receipt; a failure throws with the partial receipt attached. */
export async function executeTeardown(adapters, options, scope = QA_SCOPE) {
    validateExecuteUsage(options);
    const { teardownScope, mode, quiesce, planDigest } = options;
    adapters.assertHost();
    assertLock(adapters);
    const receipt = { result: 'failed', scope: teardownScope, mode, phase: 'plan', removedContainers: [], removedImages: [],
        retainedImages: [], removedVolumes: [], quiesce: null, workspace: null, stash: null, marker: null,
        finishedDeletions: [], legacyBackups: null, retainedBackups: [], warnings: [] };
    const warn = message => {
        receipt.warnings.push(message);
        adapters.log(`::warning::${message}`);
    };
    try {
        // 1. Pre-stop recompute of the containers, volumes and images (N4), bound to the plan digest.
        healMarkerTemporaries(adapters, scope);
        let state = readState(adapters, scope);
        if (teardownScope !== 'destroy') prove(state.marker, 'QA_TEARDOWN_MARKER_REQUIRED');
        let containers = listContainers(adapters, 'QA_TEARDOWN');
        const volumes = listVolumes(adapters, 'QA_TEARDOWN');
        const plan = containerPlan(containers, volumes, teardownScope, mode, scope);
        const images = imagePlan(containers, listImages(adapters, 'QA_TEARDOWN'), plan.remove, state.marker);
        prove(teardownDigest(teardownScope, mode, plan, images) === planDigest, 'QA_TEARDOWN_PLAN_CHANGED');
        receipt.marker = markerSummary(state.marker);

        // 2. Quiesce the running exact Box before anything is stopped.
        receipt.phase = 'quiesce';
        if (plan.exact?.running && quiesce !== 'skip') {
            if (teardownScope === 'destroy') {
                const preflight = quiesceReceipt(await adapters.quiesce(plan.exact, { preflightOnly: true }));
                receipt.quiesce = { preflight };
                prove(preflight.result === 'preflight-passed', 'QA_TEARDOWN_QUIESCE_PREFLIGHT_FAILED');
            }
            const result = quiesceReceipt(await adapters.quiesce(plan.exact, { preflightOnly: false }));
            receipt.quiesce = { ...(receipt.quiesce || {}), ...result };
            if (result.result !== 'passed') {
                prove(quiesce === 'warn', 'QA_TEARDOWN_QUIESCE_FAILED');
                warn(`Explorer QA quiesce did not pass (${result.code || result.result}); continuing because the install marker predates this run.`);
            }
        }

        // N1: record the image candidates while their containers still exist.
        receipt.phase = 'record-images';
        if (state.marker) state = { ...state, marker: recordMarkerImages(adapters, scope, images.candidates) };

        // 3. Stop, then remove, each QA container. Every step re-inspects the identity first.
        receipt.phase = 'stop';
        const current = item => {
            const found = listContainers(adapters, 'QA_TEARDOWN').filter(entry => entry.engine === item.engine && entry.id === item.id);
            prove(found.length === 1 && sameContainer(found[0], item), 'QA_TEARDOWN_CONTAINER_CHANGED');
            return found[0];
        };
        for (const item of plan.remove) {
            if (!current(item).running) continue;
            adapters.stopContainer(item.engine, item.id);
            prove(current(item).running === false, 'QA_TEARDOWN_CONTAINER_NOT_STOPPED');
        }
        receipt.phase = 'remove-containers';
        for (const item of plan.remove) {
            prove(current(item).running === false, 'QA_TEARDOWN_CONTAINER_NOT_STOPPED');
            // No -f and no -v.
            adapters.removeContainer(item.engine, item.id);
            prove(!listContainers(adapters, 'QA_TEARDOWN').some(entry => entry.engine === item.engine && entry.id === item.id),
                'QA_TEARDOWN_CONTAINER_REMOVAL_UNVERIFIED');
            receipt.removedContainers.push({ engine: item.engine, id: item.id, name: item.name });
        }

        // Decision D4: a keep-data destroy writes its marker after the containers and before the stash.
        if (teardownScope === 'destroy' && mode === 'keep-data') {
            receipt.phase = 'marker';
            const written = writeMarkerOnce(adapters, scope, { version: 1, operation: 'destroy-keep', createdAt: adapters.now(),
                dispatch: null, ...(images.candidates.length ? { images: images.candidates } : {}) });
            state = { ...state, marker: recordMarkerImages(adapters, scope, images.candidates) || written.marker };
            receipt.marker = markerSummary(state.marker);
        }

        // 4. Images: untag, then remove, only while no remaining container uses them.
        receipt.phase = 'images';
        containers = listContainers(adapters, 'QA_TEARDOWN');
        receipt.retainedImages.push(...images.retained);
        for (const image of images.remove) {
            if (containers.some(item => item.engine === image.engine && item.image === image.id)) {
                receipt.retainedImages.push({ engine: image.engine, id: image.id, tags: image.tags, reason: 'retained-in-use' });
                continue;
            }
            adapters.untagImage(image.engine, image.id, image.tags);
            adapters.removeImage(image.engine, image.id);
            prove(!listImages(adapters, 'QA_TEARDOWN').some(item => item.engine === image.engine && item.id === image.id),
                'QA_TEARDOWN_IMAGE_REMOVAL_UNVERIFIED');
            receipt.removedImages.push({ engine: image.engine, id: image.id, tags: image.tags });
        }

        // 5. Volumes: only a delete-data destroy plans any.
        receipt.phase = 'volumes';
        for (const volume of plan.volumes) {
            adapters.removeVolume(volume.engine, volume.name);
            prove(!listVolumes(adapters, 'QA_TEARDOWN').some(item => item.engine === volume.engine && item.name === volume.name),
                'QA_TEARDOWN_VOLUME_REMOVAL_UNVERIFIED');
            receipt.removedVolumes.push({ engine: volume.engine, name: volume.name });
        }

        // 6. Workspace, re-planned now that nothing writes to it any more.
        receipt.phase = 'workspace';
        // Every destroy first finishes the tombstones an interrupted delete-data destroy left behind.
        // It runs only after the quiesce and the container removal, so a refused keep-data destroy deletes nothing.
        if (teardownScope === 'destroy') receipt.finishedDeletions = privileged(adapters, 'finish-deletions').finished;
        if (mode === 'keep-data') {
            const stash = privileged(adapters, 'stash-policy');
            receipt.stash = { stashed: 'created', 'stash-kept': 'kept', 'no-policy': 'none' }[stash.result];
            const workspacePlan = privileged(adapters, 'plan-workspace', ['--scope', teardownScope, '--mode', 'keep-data']);
            const reduced = privileged(adapters, 'reduce-workspace', ['--scope', teardownScope, '--plan-digest', workspacePlan.digest]);
            receipt.workspace = { result: reduced.workspace === 'absent' ? 'absent' : 'reduced', deleted: reduced.deleted,
                keep: reduced.keep, identity: reduced.identity, digest: reduced.digest };
        } else {
            receipt.stash = state.stash ? 'removed' : 'none';
            const deleted = privileged(adapters, 'delete-data');
            receipt.workspace = { result: 'deleted', workspace: deleted.workspace, state: deleted.state };
            receipt.finishedDeletions.push(...deleted.finishedDeletions);
            receipt.marker = null;
        }

        // 7. Legacy backups (decision Q1 (a): destroy in both modes; I1 classifier).
        if (teardownScope === 'destroy') {
            receipt.phase = 'legacy-backups';
            const pruned = privileged(adapters, 'remove-legacy-backups');
            receipt.legacyBackups = { removed: pruned.removed, replayedTombstones: pruned.replayedTombstones };
            receipt.retainedBackups = [
                ...pruned.retained.map(item => ({ name: item.name, reason: item.class })),
                ...pruned.retainedSiblings.map(name => ({ name, reason: 'sibling-of-retained' })),
                ...pruned.unrecognized.map(name => ({ name, reason: 'unrecognized' })),
            ];
        }
        receipt.phase = 'done';
        receipt.result = 'torn-down';
        return receipt;
    } catch (error) {
        receipt.code = safeCode(error, 'QA_TEARDOWN_FAILED');
        if (error?.privileged) receipt.privileged = error.privileged;
        throw Object.assign(error, { receipt });
    }
}

/** Contract 2 r2: removes only the marker, once the new exact Box runs and the stash is restored. */
export function completeInstall(adapters, scope = QA_SCOPE) {
    adapters.assertHost();
    assertLock(adapters);
    healMarkerTemporaries(adapters, scope);
    const state = readState(adapters, scope);
    prove(state.marker, 'QA_TEARDOWN_MARKER_ABSENT');
    prove(!state.stash, 'QA_TEARDOWN_STASH_NOT_RESTORED');
    const qa = classifyContainers(listContainers(adapters, 'QA_TEARDOWN'), scope);
    prove(qa.conflicts.length === 0 && qa.unknown.length === 0 && qa.exact.length === 1 && qa.exact[0].running === true,
        'QA_TEARDOWN_EXACT_BOX_NOT_RUNNING');
    fs.unlinkSync(path.join(scope.state, MARKER_NAME));
    prove(present(path.join(scope.state, MARKER_NAME)) === null, 'QA_TEARDOWN_MARKER_REMOVAL_UNVERIFIED');
    return { result: 'completed', marker: markerSummary(state.marker), exact: exactSummary(qa.exact[0]) };
}

/** The tail's restore (contract 2 r2): copy the stash into the fresh policy, prove it, remove the stash. */
export function restoreStash(adapters, scope = QA_SCOPE) {
    adapters.assertHost();
    assertLock(adapters);
    healMarkerTemporaries(adapters, scope);
    readState(adapters, scope);
    return privileged(adapters, 'stash-restore');
}

export function clearStash(adapters, scope = QA_SCOPE) {
    adapters.assertHost();
    assertLock(adapters);
    healMarkerTemporaries(adapters, scope);
    readState(adapters, scope);
    return privileged(adapters, 'stash-clear');
}

/**
 * Contract 8: the record format of the former inline snapshot, plus one
 * `{engine, kind:"image", id, tags}` record for each protected container's image.
 */
export function protectedSnapshot(adapters, scope = QA_SCOPE) {
    const protectedState = [];
    const seenImages = new Set();
    for (const engine of ENGINES.filter(item => adapters.engineInstalled(item))) {
        const containerIds = adapters.run(engine, ['container', 'ls', '-aq']).split('\n').filter(Boolean);
        for (const id of containerIds) {
            const item = JSON.parse(adapters.run(engine, ['container', 'inspect', id]))[0];
            const labels = item?.Config?.Labels || item?.Labels || {};
            const name = String(item?.Name || '').replace(/^\//, '');
            if (labels[PATH_HASH_LABEL] === scope.hash || name === scope.box) continue;
            protectedState.push({ engine, kind: 'container', id: item.Id, name, image: item.Image,
                labels: Object.fromEntries(Object.entries(labels).sort()) });
            const imageKey = `${engine}|${item.Image}`;
            if (seenImages.has(imageKey)) continue;
            seenImages.add(imageKey);
            const image = JSON.parse(adapters.run(engine, ['image', 'inspect', item.Image]))[0];
            prove(image && typeof image.Id === 'string', 'QA_TEARDOWN_SNAPSHOT_FAILED');
            protectedState.push({ engine, kind: 'image', id: image.Id,
                tags: (Array.isArray(image.RepoTags) ? image.RepoTags : []).filter(tag => !PROTECTED_EXCLUDED_TAGS.includes(tag)).sort() });
        }
        const volumeNames = adapters.run(engine, ['volume', 'ls', '-q']).split('\n').filter(Boolean);
        for (const name of volumeNames) {
            const item = JSON.parse(adapters.run(engine, ['volume', 'inspect', name]))[0];
            const labels = item?.Labels || {};
            if (labels[PATH_HASH_LABEL] === scope.hash || name.startsWith(`${scope.box}-`)) continue;
            protectedState.push({ engine, kind: 'volume', name, labels: Object.fromEntries(Object.entries(labels).sort()) });
        }
    }
    protectedState.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return protectedState;
}

const commandEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PLOINKY_|CLOUDFLARE_|GIT_)/.test(key)));

/** `spawn` is injectable so tests can pin the exact argv and options of every external command. */
export function productionAdapters(scope = QA_SCOPE, { spawn = spawnSync } = {}) {
    const env = commandEnv();
    const call = (engine, args, timeout = 120_000, code = 'QA_TEARDOWN_ENGINE_PROBE_FAILED') => {
        prove(ENGINES.includes(engine), code);
        const result = spawn(engine, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'], env });
        prove(!result.error && result.status === 0, code);
        return result.stdout;
    };
    const engineInstalled = engine => spawn('sh', ['-c', 'command -v "$1"', 'sh', engine], { encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).status === 0;
    const inspectAll = (engine, kind, ids) => {
        if (ids.length === 0) return [];
        let rows = null;
        try { rows = JSON.parse(call(engine, [kind, 'inspect', ...ids])); } catch { rows = null; }
        prove(Array.isArray(rows) && rows.length === ids.length, 'QA_TEARDOWN_ENGINE_PROBE_FAILED');
        return rows;
    };
    const fullIds = text => {
        const ids = [...new Set(text.split(/\s+/).filter(Boolean).map(stripId))];
        prove(ids.every(id => FULL_ID.test(id)), 'QA_TEARDOWN_ENGINE_PROBE_FAILED');
        return ids;
    };
    return {
        assertHost() {
            prove(process.platform === 'linux' && os.userInfo().username === 'admin' && os.homedir() === '/home/admin'
                && scope.workspace === QA_SCOPE.workspace && scope.state === QA_SCOPE.state, 'QA_HOST_INVALID');
        },
        getuid: () => process.getuid(),
        now: () => new Date().toISOString(),
        log: line => process.stderr.write(`${line}\n`),
        lockHeld() {
            const locked = spawn('flock', ['-n', '-E', '75', scope.lock, 'true'], { encoding: 'utf8', timeout: 5000 });
            return !locked.error && locked.status === 75;
        },
        freeBytes() {
            const stat = fs.statfsSync(path.dirname(scope.workspace), { bigint: true });
            return Number(stat.bavail * stat.bsize);
        },
        // Light summary of every container in each installed engine: no sanitizing and no image probe.
        containers() {
            const result = [];
            for (const engine of ENGINES.filter(engineInstalled)) {
                const ids = fullIds(call(engine, ['container', 'ls', '-aq', '--no-trunc']));
                for (const row of inspectAll(engine, 'container', ids)) {
                    prove(ids.includes(row?.Id) && typeof row.Name === 'string' && typeof row.State?.Running === 'boolean',
                        'QA_TEARDOWN_ENGINE_PROBE_FAILED');
                    const labels = row.Config?.Labels;
                    result.push({ engine, id: row.Id, name: row.Name.replace(/^\//, ''), running: row.State.Running,
                        image: stripId(row.Image), labels: labels && typeof labels === 'object' ? { ...labels } : {} });
                }
            }
            return result;
        },
        volumes() {
            const result = [];
            for (const engine of ENGINES.filter(engineInstalled)) {
                const names = call(engine, ['volume', 'ls', '-q']).split('\n').filter(Boolean);
                for (const row of inspectAll(engine, 'volume', names)) {
                    prove(names.includes(row?.Name), 'QA_TEARDOWN_ENGINE_PROBE_FAILED');
                    result.push({ engine, name: row.Name, labels: row.Labels && typeof row.Labels === 'object' ? { ...row.Labels } : {} });
                }
            }
            return result;
        },
        images() {
            const result = [];
            for (const engine of ENGINES.filter(engineInstalled)) {
                const ids = fullIds(call(engine, ['image', 'ls', '-q', '--no-trunc']));
                for (const row of inspectAll(engine, 'image', ids)) {
                    const id = stripId(row?.Id);
                    prove(ids.includes(id) && Number.isSafeInteger(Number(row.Size)), 'QA_TEARDOWN_ENGINE_PROBE_FAILED');
                    result.push({ engine, id, tags: Array.isArray(row.RepoTags) ? row.RepoTags.filter(tag => typeof tag === 'string') : [],
                        digests: Array.isArray(row.RepoDigests) ? row.RepoDigests.filter(tag => typeof tag === 'string') : [],
                        size: Number(row.Size) });
                }
            }
            return result;
        },
        // The quiesce source contract: the helper on stdin inside the exact Box, as the deploy runs it.
        async quiesce(item, { preflightOnly }) {
            const source = fs.readFileSync(new URL('./quiesce-explorer-qa.mjs', import.meta.url), 'utf8');
            const result = spawn(item.engine, ['container', 'exec', '-i', '--user', 'podman', '--workdir', scope.workspace,
                '--env', `PLOINKY_WORKSPACE_ROOT=${scope.workspace}`, '--env', 'PLOINKY_ROUTER_HOST_PORT=8097',
                '--env', 'PLOINKY_MEDIA_HOST_PORT=7882', ...(preflightOnly ? ['--env', 'QA_QUIESCE_PREFLIGHT_ONLY=1'] : []),
                item.id, 'node', '--input-type=module', '-'], { input: source, encoding: 'utf8', timeout: QUIESCE_EXEC_TIMEOUT_MS,
                maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], env });
            const line = String(result.stdout || '').split('\n').filter(Boolean).at(-1);
            let receipt = null;
            try { receipt = JSON.parse(line); } catch {}
            // As in the deploy before, a failed exec fails the quiesce whatever its last line says.
            if (result.error || result.status !== 0) {
                return { result: 'failed', code: /^QA_[A-Z_]+$/.test(String(receipt?.code || '')) ? receipt.code : 'QA_TEARDOWN_QUIESCE_EXEC_FAILED' };
            }
            return receipt && typeof receipt === 'object' ? receipt : { result: 'failed', code: 'QA_TEARDOWN_QUIESCE_EXEC_FAILED' };
        },
        stopContainer: (engine, id) => call(engine, ['container', 'stop', '--time', '30', id], 45_000, 'QA_TEARDOWN_STOP_FAILED'),
        removeContainer: (engine, id) => call(engine, ['container', 'rm', id], 120_000, 'QA_TEARDOWN_CONTAINER_REMOVAL_FAILED'),
        untagImage(engine, id, tags) {
            // Docker has no `image untag`; removing a tag reference by name is its untag.
            if (engine === 'podman') call(engine, ['image', 'untag', id], 120_000, 'QA_TEARDOWN_IMAGE_REMOVAL_FAILED');
            else for (const tag of tags) call(engine, ['image', 'rm', tag], 120_000, 'QA_TEARDOWN_IMAGE_REMOVAL_FAILED');
        },
        removeImage(engine, id) {
            if (engine === 'docker' && !fullIds(call(engine, ['image', 'ls', '-q', '--no-trunc'])).includes(id)) return;
            call(engine, ['image', 'rm', id], 300_000, 'QA_TEARDOWN_IMAGE_REMOVAL_FAILED');
        },
        removeVolume: (engine, name) => call(engine, ['volume', 'rm', name], 120_000, 'QA_TEARDOWN_VOLUME_REMOVAL_FAILED'),
        runPrivileged(args) {
            const source = fs.readFileSync(new URL('./qa-teardown-privileged.mjs', import.meta.url), 'utf8');
            // The sudoers rule admits /usr/bin/node reading its program from stdin.
            const result = spawn('sudo', ['-n', '/usr/bin/node', '--input-type=module', '-', ...args], {
                input: source, encoding: 'utf8', timeout: PRIVILEGED_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
                stdio: ['pipe', 'pipe', 'pipe'], env });
            return { status: result.status, error: Boolean(result.error), stdout: result.stdout };
        },
        engineInstalled,
        run: (engine, args) => call(engine, args, 120_000, 'QA_TEARDOWN_SNAPSHOT_FAILED').trim(),
    };
}

const COMMANDS = Object.freeze({
    route: { required: ['--lock-held'], optional: [] },
    plan: { required: ['--scope', '--mode'], optional: ['--lock-held'] },
    mark: { required: ['--operation', '--dispatch', '--lock-held'], optional: [] },
    execute: { required: ['--scope', '--mode', '--quiesce', '--plan-digest', '--lock-held'], optional: [] },
    complete: { required: ['--lock-held'], optional: [] },
    'stash-restore': { required: ['--lock-held'], optional: [] },
    'stash-clear': { required: ['--lock-held'], optional: [] },
    'protected-snapshot': { required: [], optional: [] },
});

/** `<command> --flag value … --lock-held`: every required flag exactly once, no other flag. */
export function parseArguments(argv) {
    const [command, ...rest] = argv;
    const spec = COMMANDS[command];
    prove(spec, 'QA_TEARDOWN_USAGE_INVALID');
    const flags = {};
    for (let index = 0; index < rest.length; index += 1) {
        const flag = rest[index];
        prove([...spec.required, ...spec.optional].includes(flag) && !(flag in flags), 'QA_TEARDOWN_USAGE_INVALID');
        if (flag === '--lock-held') { flags[flag] = true; continue; }
        prove(typeof rest[index + 1] === 'string' && !rest[index + 1].startsWith('--'), 'QA_TEARDOWN_USAGE_INVALID');
        flags[flag] = rest[index + 1];
        index += 1;
    }
    prove(spec.required.every(flag => flag in flags), 'QA_TEARDOWN_USAGE_INVALID');
    if ('--scope' in flags) prove(TEARDOWN_SCOPES.includes(flags['--scope']), 'QA_TEARDOWN_USAGE_INVALID');
    if ('--mode' in flags) prove(TEARDOWN_MODES.includes(flags['--mode']), 'QA_TEARDOWN_USAGE_INVALID');
    if (command === 'plan') prove(flags['--mode'] === 'keep-data' || flags['--scope'] === 'destroy', 'QA_TEARDOWN_USAGE_INVALID');
    return { command, teardownScope: flags['--scope'], mode: flags['--mode'], quiesce: flags['--quiesce'],
        planDigest: flags['--plan-digest'], operation: flags['--operation'], dispatch: flags['--dispatch'],
        lockHeld: flags['--lock-held'] === true };
}

/** Returns the exit status and the single JSON value; nothing is printed here. */
export async function run(argv, adapters = null, scope = QA_SCOPE) {
    let parsed;
    try { parsed = parseArguments(argv); }
    catch (error) {
        const routeOrPlan = argv[0] === 'route' || argv[0] === 'plan';
        return { status: 1, output: { result: routeOrPlan ? 'refused' : 'failed', code: safeCode(error, 'QA_TEARDOWN_USAGE_INVALID') } };
    }
    const selected = adapters || productionAdapters(scope);
    try {
        switch (parsed.command) {
        case 'route': return { status: 0, output: routeDeployment(selected, scope) };
        case 'plan': return { status: 0, output: planTeardown(selected, parsed, scope) };
        case 'mark': return { status: 0, output: markInstall(selected, parsed, scope) };
        case 'execute': return { status: 0, output: await executeTeardown(selected, parsed, scope) };
        case 'complete': return { status: 0, output: completeInstall(selected, scope) };
        case 'stash-restore': return { status: 0, output: restoreStash(selected, scope) };
        case 'stash-clear': return { status: 0, output: clearStash(selected, scope) };
        default: return { status: 0, output: protectedSnapshot(selected, scope) };
        }
    } catch (error) {
        if (error?.receipt) return { status: 1, output: error.receipt };
        const refused = parsed.command === 'route' || parsed.command === 'plan';
        return { status: 1, output: { result: refused ? 'refused' : 'failed',
            code: safeCode(error, parsed.command === 'route' ? 'QA_ROUTE_REJECTED' : 'QA_TEARDOWN_FAILED'),
            ...(error?.privileged ? { privileged: error.privileged } : {}) } };
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { status, output } = await run(process.argv.slice(2));
    process.stdout.write(JSON.stringify(output) + '\n');
    process.exitCode = status;
}
