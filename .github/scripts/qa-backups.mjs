#!/usr/bin/env node
// Admin-side QA backup retention and rollback-target selection. The prune runs
// under the host lock inside Reconcile, before the capacity admission, and only
// while the current QA Box is proven ready and healthy. Backup files are
// classified and deleted by qa-backups-privileged.mjs in one root process; this
// side never reads the root-owned receipts. Boxes are removed afterwards, only
// when bound to a removed backup by name and by the ID recorded before deletion.
// `route --lock-held` is the read-only deployment route taken before `select`:
// it either hands an exact-name Box to `select`, proves that an interrupted
// preserving redeploy can be resumed, or refuses.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { currentQaBox, productionAdapters, QA_SCOPE } from './rollback-explorer-qa.mjs';
// Namespace import: the readiness proof is dereferenced when the adapters are built.
import * as update from './update-explorer-qa.mjs';

// Every name the deploy workflow and the rollback helper write inside a backup,
// and every `<backup>-<suffix>` sibling. Keep these lists literal; the
// privileged module has its own copy and a test compares the two.
export const BACKUP_INNER_ENTRIES = Object.freeze({
    completion: Object.freeze(['helpers', 'prior-containers.txt', 'rollback-authority.json', 'preservation.json',
        'workspace', 'quiesce.log', 'quiesce-source.mjs', 'lock-ready.json', 'lock-released.json', 'lock-release',
        'lock.log', 'lock-source.txt', 'policy-restoration.json', 'restored-selections.json']),
    rollbackMarkers: Object.freeze(['rollback-result.json', /^rollback-result\.json\.[a-f0-9]{16}$/, 'failed-workspace']),
});
export const BACKUP_SIBLING_SUFFIXES = Object.freeze(['helpers', 'lock-ready.json', 'lock-released.json', 'lock-release',
    'lock.log', 'lock-source.txt', 'quiesce.log']);
// The deletion of ~24 GB must fit inside the deploy job, never inside a short command timeout.
export const PRIVILEGED_TIMEOUT_MS = 2_700_000;

const FULL_ID = /^[a-f0-9]{64}$/;
const BACKUP = /^redeploy-[A-Za-z0-9]{8}$/;
const RETAINED_CLASSES = ['rollback-attempted', 'unrecognized-entry', 'stop-attempted-unpreserved', 'incomplete-redeploy'];
const CREATED_AT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/;
const safeCode = (error, fallback) => /^(?:QA_|PLOINKY_BOX_)[A-Z_]+$/.test(error?.code || '') ? error.code : fallback;
const present = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const isFile = stat => Boolean(stat?.isFile() && !stat.isSymbolicLink());
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function prove(condition, code, extra = {}) {
    if (!condition) throw Object.assign(new Error(code), { code, ...extra });
}

const retainedBoxName = (scope, name) => name.startsWith(scope.box + '-')
    && /^(?:rollback|failed)-redeploy-[A-Za-z0-9]{8}$/.test(name.slice(scope.box.length + 1));

/** Strict parse of the privileged module's single JSON line. */
export function parsePrivilegedOutput(stdout) {
    const lines = String(stdout ?? '').split('\n').filter(line => line !== '');
    prove(lines.length === 1, 'QA_RETENTION_PRIVILEGED_OUTPUT_INVALID');
    let value;
    try { value = JSON.parse(lines[0]); } catch { prove(false, 'QA_RETENTION_PRIVILEGED_OUTPUT_INVALID'); }
    const names = list => Array.isArray(list) && list.every(item => typeof item === 'string' && /^[^\u0000-\u001f\u007f]{1,255}$/u.test(item));
    prove(value && value.result === 'pruned' && Object.keys(value).sort().join(',') === 'removed,replayedTombstones,result,retained,unrecognized'
        && Array.isArray(value.removed) && value.removed.every(item => item && BACKUP.test(item.name)
            && (item.priorRecord === null || typeof item.priorRecord === 'string'))
        && Array.isArray(value.retained) && value.retained.every(item => item && BACKUP.test(item.name)
            && RETAINED_CLASSES.includes(item.class))
        && names(value.unrecognized) && names(value.replayedTombstones), 'QA_RETENTION_PRIVILEGED_OUTPUT_INVALID');
    return value;
}

/** Prune proofs (a) to (f) of the reviewed retention contract. */
export function createRetentionService(adapters, scope = QA_SCOPE) {
    const priorRecord = new RegExp(`^(podman|docker)\\|([a-f0-9]{64})\\|${escapeRegExp(scope.box)}$`);

    async function prune({ currentId }) {
        prove(FULL_ID.test(currentId || ''), 'QA_RETENTION_USAGE_INVALID');
        adapters.assertHost();
        // (a) Only the holder of the host lock may delete.
        prove(adapters.lockHeld() === true, 'QA_RETENTION_HOST_LOCK_REQUIRED');
        prove(typeof adapters.assertRuntimeReady === 'function', 'QA_RETENTION_READINESS_PROOF_UNAVAILABLE');
        // (b) The exact-name Box is the one Reconcile recorded.
        const boxes = adapters.boxes();
        const exact = boxes.filter(item => item.box.name === scope.box);
        prove(exact.length === 1 && exact[0].box.id === currentId, 'QA_RETENTION_CURRENT_CHANGED');
        const current = exact[0];
        // (c) Health gate: an unproven QA keeps every backup, and the run continues.
        try {
            prove(current.box.running === true, 'QA_RETENTION_CURRENT_NOT_RUNNING');
            const runtime = await adapters.runtime(current);
            prove(runtime && Array.isArray(runtime.agents) && runtime.agents.length > 0, 'QA_RETENTION_RUNTIME_NOT_READY');
            adapters.assertRuntimeReady({ runtime });
            await adapters.health(current);
        } catch (error) {
            return { result: 'skipped', reason: safeCode(error, 'QA_RETENTION_HEALTH_UNPROVEN'), removedBackups: [], removedBoxes: [] };
        }
        // (d) Only the one running exact Box and stopped retained Boxes exist.
        currentQaBox(boxes, scope);
        // (e) One root process classifies and deletes.
        const run = adapters.runPrivileged(adapters.privilegedSource(), ['prune', '--root', scope.backups,
            '--workspace', scope.workspace, '--owner', String(adapters.getuid())]);
        if (!run || run.error || run.status !== 0) {
            let failure = null;
            try { failure = JSON.parse(String(run?.stdout || '').trim()); } catch {}
            const removedBeforeFailure = Array.isArray(failure?.removedBeforeFailure)
                ? failure.removedBeforeFailure.filter(name => BACKUP.test(name)) : [];
            prove(false, 'QA_RETENTION_PRIVILEGED_FAILED', { receipt: { result: 'failed', code: 'QA_RETENTION_PRIVILEGED_FAILED',
                privilegedCode: /^QA_[A-Z_]+$/.test(failure?.code || '') ? failure.code : null, removedBackups: removedBeforeFailure,
                removedBoxes: [] } });
        }
        const privileged = parsePrivilegedOutput(run.stdout);
        // (f) Boxes bound to a removed backup by name and by the record read before deletion.
        const removedBackups = privileged.removed.map(item => item.name);
        const removedBoxes = [], orphanedAnonymousVolumes = [];
        let latest = boxes;
        for (const item of privileged.removed) {
            const record = priorRecord.exec(item.priorRecord || '');
            if (!record) continue;
            const [, engine, id] = record;
            const name = `${scope.box}-rollback-${item.name}`;
            const observed = boxes.filter(box => box.engine === engine && box.box.id === id);
            if (id === currentId || observed.length !== 1 || observed[0].box.name !== name || observed[0].box.running !== false) continue;
            try {
                latest = adapters.boxes();
                const again = latest.filter(box => box.engine === engine && box.box.id === id);
                prove(again.length === 1 && again[0].box.name === name && again[0].box.running === false
                    && again[0].box.contract === observed[0].box.contract, 'QA_RETENTION_BOX_CHANGED');
                // No -f and no -v: anonymous volumes stay, reported, for the protected-resource comparison.
                adapters.removeContainer(engine, id);
            } catch (error) {
                throw Object.assign(new Error(safeCode(error, 'QA_RETENTION_BOX_REMOVAL_FAILED')), {
                    code: safeCode(error, 'QA_RETENTION_BOX_REMOVAL_FAILED'),
                    receipt: { result: 'failed', code: safeCode(error, 'QA_RETENTION_BOX_REMOVAL_FAILED'), removedBackups, removedBoxes } });
            }
            removedBoxes.push({ engine, id, name });
            for (const mount of observed[0].box.mounts || []) {
                if (mount.Type === 'volume') orphanedAnonymousVolumes.push({ engine, boxId: id, source: mount.Source, destination: mount.Destination });
            }
        }
        const removedIds = new Set(removedBoxes.map(box => `${box.engine}|${box.id}`));
        const retainedUnproven = latest.filter(box => !removedIds.has(`${box.engine}|${box.box.id}`) && retainedBoxName(scope, box.box.name))
            .map(box => ({ engine: box.engine, id: box.box.id, name: box.box.name }));
        return { result: 'pruned', removedBackups, removedBoxes, retained: privileged.retained,
            unrecognized: privileged.unrecognized, replayedTombstones: privileged.replayedTombstones,
            retainedUnproven, orphanedAnonymousVolumes };
    }
    return { prune };
}

/**
 * Read-only admin inventory of the backups root, newest `createdAt` first and
 * undated last. Only admin-owned files are read; root-owned receipts are
 * checked with lstat alone. The rollback-target selection and the deployment
 * route both classify these facts.
 */
export function inventoryBackups(adapters, scope = QA_SCOPE) {
    const uid = adapters.getuid();
    const rootStat = present(scope.backups);
    const backups = [];
    if (rootStat) {
        prove(rootStat.isDirectory() && !rootStat.isSymbolicLink() && rootStat.uid === uid
            && fs.realpathSync(scope.backups) === scope.backups, 'QA_BACKUP_ROOT_INVALID');
        for (const name of fs.readdirSync(scope.backups).sort()) {
            const file = path.join(scope.backups, name), stat = BACKUP.test(name) ? present(file) : null;
            if (stat?.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o077) === 0
                && fs.realpathSync(file) === file) backups.push({ name, file });
        }
    }
    const predecessorPattern = new RegExp(`^(?:podman|docker)\\|([a-f0-9]{64})\\|${escapeRegExp(scope.box)}\\n?$`);
    return backups.map(({ name, file }) => {
        const inside = relative => present(path.join(file, relative));
        let createdAt = null;
        const authority = inside('rollback-authority.json');
        if (isFile(authority) && authority.uid === uid && authority.size <= 16 * 1024 * 1024) {
            try {
                const value = JSON.parse(fs.readFileSync(path.join(file, 'rollback-authority.json'), 'utf8'));
                if (typeof value?.createdAt === 'string' && CREATED_AT.test(value.createdAt)
                    && Number.isFinite(Date.parse(value.createdAt))) createdAt = value.createdAt;
            } catch {}
        }
        let predecessorId = null, priorRecord = null;
        const prior = inside('prior-containers.txt');
        if (isFile(prior) && prior.uid === uid && prior.size <= 4096) {
            priorRecord = fs.readFileSync(path.join(file, 'prior-containers.txt'), 'utf8');
            predecessorId = predecessorPattern.exec(priorRecord)?.[1] || null;
        }
        const marker = fs.readdirSync(file).some(entry => BACKUP_INNER_ENTRIES.rollbackMarkers
            .some(item => typeof item === 'string' ? item === entry : item.test(entry)));
        const workspace = inside('workspace');
        const helpers = inside('helpers');
        const helpersValid = Boolean(helpers?.isDirectory() && !helpers.isSymbolicLink()
            && isFile(inside('helpers/node-runtime-path')) && isFile(inside('helpers/rollback-explorer-qa.mjs')));
        return {
            name, file, createdAt, predecessorId, priorRecord, marker, helpersValid,
            quiesced: Boolean(inside('quiesce.log') || present(`${file}-quiesce.log`)),
            preserved: Boolean(inside('preservation.json')),
            // `directory` only for a real directory; any other entry type is `other`.
            workspace: workspace ? (workspace.isDirectory() && !workspace.isSymbolicLink() ? 'directory' : 'other') : null,
            quiesceSource: isFile(inside('quiesce-source.mjs')),
            policyRestoration: Boolean(inside('policy-restoration.json')),
            restoredSelections: Boolean(inside('restored-selections.json')),
        };
    }).sort((left, right) => (right.createdAt ? Date.parse(right.createdAt) : -Infinity)
        - (left.createdAt ? Date.parse(left.createdAt) : -Infinity) || left.name.localeCompare(right.name));
}

/**
 * Read-only. The newest backup that changed QA state is the only target; an
 * ineligible newest backup is refused rather than replaced by an older one.
 */
export function selectRollbackTarget(adapters, scope = QA_SCOPE) {
    const inventory = inventoryBackups(adapters, scope);
    const boxes = adapters.boxes();
    const candidates = inventory.map(item => {
        const { name, createdAt, predecessorId } = item;
        // A stopped exact-name predecessor is stop evidence: Reconcile can stop it without a quiesce log.
        // So is the moved live workspace, which exists before preservation.json is written.
        const stopped = predecessorId !== null && boxes.some(box => box.box.id === predecessorId
            && box.box.name === scope.box && box.box.running === false);
        const stopEvidence = item.quiesced || item.preserved || item.workspace !== null || stopped;
        let reason = null;
        if (createdAt === null) reason = 'undated';
        else if (item.marker) reason = 'rollback-already-attempted';
        else if (!stopEvidence) reason = 'no-stop-evidence';
        else if (!item.helpersValid) reason = 'helpers-missing';
        else if (!predecessorId) reason = 'no-predecessor';
        return { name, createdAt, eligible: reason === null, reason, predecessorId };
    });
    const listed = candidates.map(({ name, createdAt, eligible, reason }) => ({ name, createdAt, eligible, reason }));
    // Undated backups and attempts that never changed QA state do not take part in the ordering.
    const ordered = candidates.filter(item => item.reason !== 'undated' && item.reason !== 'no-stop-evidence');
    prove(ordered.length > 0, 'QA_ROLLBACK_TARGET_NONE', { receipt: { result: 'failed', code: 'QA_ROLLBACK_TARGET_NONE', candidates: listed } });
    const newest = ordered[0];
    prove(ordered.length === 1 || Date.parse(ordered[1].createdAt) !== Date.parse(newest.createdAt), 'QA_ROLLBACK_TARGET_AMBIGUOUS',
        { receipt: { result: 'failed', code: 'QA_ROLLBACK_TARGET_AMBIGUOUS', candidates: listed } });
    prove(newest.eligible, 'QA_ROLLBACK_TARGET_REFUSED',
        { receipt: { result: 'refused', backup: newest.name, reason: newest.reason, candidates: listed } });
    const exact = boxes.filter(item => item.box.name === scope.box);
    prove(exact.length <= 1, 'QA_BOX_AMBIGUOUS');
    const currentId = exact.length === 0 || exact[0].box.id === newest.predecessorId ? 'absent' : exact[0].box.id;
    return { result: 'selected', backup: newest.name, currentId, predecessorId: newest.predecessorId, candidates: listed };
}

// Everything the resumed Reconcile tail itself writes into the live workspace
// before the new Box exists, and nothing else. The workflow tail writes the
// bootstrap `.env`, clones `.runtime/ploinky` and `AdvancedLanguageAgent`, and
// writes `.ploinky/edge-desired.json`; a test pins these against the workflow.
// `prepareBoxForCommand` then creates `.ploinky/box` and its two data
// directories before the container exists (Ploinky f2b2c4d1
// `ploinky-box/workspace-data.mjs:233-270` `ensureWorkspaceDataPaths`, with
// `BOX_DATA_KEYS` and `BOX_DATA_ROOT_NAME` at `ploinky-box/constants.mjs:82-91`).
// Keep the list literal.
export const RESUME_REGENERABLE = Object.freeze(['.env', '.runtime/ploinky', 'AdvancedLanguageAgent',
    '.ploinky/edge-desired.json', '.ploinky/box/dependencies', '.ploinky/box/images']);
// The fresh clones among them, each with the only origin it may have.
const RESUME_CLONES = Object.freeze({ '.runtime/ploinky': 'ploinky', AdvancedLanguageAgent: 'AdvancedLanguageAgent' });
// Edge initialisation and policy restoration write these only after the Box exists.
const GRAPH_DATA_ENTRIES = Object.freeze(['edge-routing', 'edge-publication', 'router-security']);
const BOOTSTRAP_ENV = /^PLOINKY_MASTER_KEY=[A-Fa-f0-9]{64}\n$/;
const PATH_HASH_LABEL = 'io.assistos.ploinky-box.path-hash';
// The backup's own Node runtime, exactly as rollback-explorer-qa.yml admits it.
const BACKUP_NODE_RUNTIME = /^\/home\/admin\/\.qa-deployment-tools\/node-v24\.19\.0-linux-(?:x64|arm64)$/;
const BACKUP_NODE_VERSION = 'v24.19.0';
// B's plan measures the durable data and probes the predecessor image.
export const BACKUP_HELPER_TIMEOUT_MS = 1_800_000;

/** A `copied` entry of preservation.json. The privileged module has its own copy; a test compares them. */
export function isCopiedEntry(entry) {
    return typeof entry === 'string' && entry.length > 0 && entry.length <= 4096 && !path.isAbsolute(entry)
        && path.normalize(entry) === entry && !/[\u0000-\u001f\u007f]/u.test(entry)
        && entry.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

function refuse(code, refusal = {}) {
    throw Object.assign(new Error(code), { code, refusal });
}

// `QA_RESUME_IDENTITY_CHANGED` becomes `identity-changed`; any other code keeps the fallback.
const resumeReason = (code, fallback) => /^QA_RESUME_[A-Z_]+$/.test(code || '')
    ? code.slice('QA_RESUME_'.length).toLowerCase().replace(/_/g, '-') : fallback;
// Entry names only, never contents; an unusual name is not echoed.
const entryReason = relative => relative.length <= 200 && /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(relative)
    ? `unexpected-entry:${relative}` : 'unexpected-entry';
const realDirectory = stat => Boolean(stat?.isDirectory() && !stat.isSymbolicLink());

const singleJsonLine = stdout => {
    const lines = String(stdout ?? '').split('\n').filter(line => line !== '');
    if (lines.length !== 1) return null;
    try { return JSON.parse(lines[0]); } catch { return null; }
};

/** Strict parse of the privileged `resume-proof` line. */
export function parseResumeProof(stdout, backup) {
    const value = singleJsonLine(stdout);
    prove(value && value.result === 'proved' && Object.keys(value).sort().join(',') === 'backup,copied,result'
        && value.backup === backup && Array.isArray(value.copied) && value.copied.every(isCopiedEntry)
        && new Set(value.copied).size === value.copied.length, 'QA_RESUME_PROOF_OUTPUT_INVALID');
    return value;
}

/** The backup's own Node and helper, admitted exactly as the rollback workflow admits them. */
export function backupHelperCommand(backup, scope = QA_SCOPE) {
    prove(path.dirname(backup) === scope.backups && BACKUP.test(path.basename(backup)), 'QA_RESUME_HELPER_INVALID');
    const runtimeFile = path.join(backup, 'helpers/node-runtime-path');
    const helper = path.join(backup, 'helpers/rollback-explorer-qa.mjs');
    const runtime = present(runtimeFile);
    prove(isFile(runtime) && runtime.size <= 4096 && isFile(present(helper)), 'QA_RESUME_HELPER_INVALID');
    const text = fs.readFileSync(runtimeFile, 'utf8');
    const home = text.endsWith('\n') ? text.slice(0, -1) : text;
    prove(BACKUP_NODE_RUNTIME.test(home), 'QA_RESUME_HELPER_RUNTIME_INVALID');
    return { node: path.join(home, 'bin/node'), args: [helper, 'plan', backup, '--current-id', 'absent', '--lock-held'] };
}

/** R7: the backup's own helper plans a rollback to exactly this predecessor, with no current Box. */
export function acceptedBackupPlan(run, predecessorId) {
    const value = run && !run.error && run.status === 0 ? singleJsonLine(run.stdout) : null;
    return Boolean(value && value.result === 'planned' && value.predecessorId === predecessorId
        && value.currentId === null && value.mutations === false);
}

/** R8 with I1 and N6: the live workspace holds the preserved copy and only what the tail regenerates. */
function assertResumeWorkspace(adapters, scope, backup, copied, fail) {
    const uid = adapters.getuid();
    for (const clone of Object.keys(RESUME_CLONES)) {
        if (copied.some(entry => entry === clone || entry.startsWith(clone + '/'))) fail('managed-source-invalid');
    }
    // The allowed names inside `directory` are derived from the full multi-segment paths.
    const childNames = (entries, directory) => entries
        .filter(entry => directory === '' || entry.startsWith(directory + '/'))
        .map(entry => (directory === '' ? entry : entry.slice(directory.length + 1)).split('/')[0]);
    const regenerable = RESUME_REGENERABLE.filter(entry => entry !== '.env');
    const previousData = realDirectory(present(path.join(backup.file, 'workspace/.ploinky/data')));
    // N6: a `.env` the tail wrote is admitted only in its exact bootstrap form, and only when the backup had none.
    const bootstrapEnv = () => {
        if (present(path.join(backup.file, 'workspace/.env')) !== null) return false;
        const file = path.join(scope.workspace, '.env'), stat = present(file);
        return isFile(stat) && stat.nlink === 1 && stat.uid === uid && stat.size === 84
            && BOOTSTRAP_ENV.test(fs.readFileSync(file, 'utf8'));
    };
    for (const directory of ['', '.runtime', '.ploinky', '.ploinky/box', '.ploinky/data']) {
        const absolute = directory ? path.join(scope.workspace, directory) : scope.workspace;
        const stat = present(absolute);
        if (!stat) {
            if (directory === '.ploinky') fail('workspace-state-missing');
            continue;
        }
        if (!realDirectory(stat)) fail('unexpected-type');
        const allowed = new Set([...childNames(regenerable, directory), ...childNames(copied, directory)]);
        if (directory === '.ploinky' && previousData) allowed.add('data');
        for (const name of fs.readdirSync(absolute).sort()) {
            const relative = directory ? `${directory}/${name}` : name;
            if (directory === '.ploinky/data' && GRAPH_DATA_ENTRIES.includes(name)) fail(entryReason(relative), 'QA_RESUME_GRAPH_STARTED');
            if (allowed.has(name) || (relative === '.env' && bootstrapEnv())) continue;
            fail(entryReason(relative), 'QA_RESUME_GRAPH_STARTED');
        }
    }
    for (const [relative, repository] of Object.entries(RESUME_CLONES)) {
        const directory = path.join(scope.workspace, relative), stat = present(directory);
        if (!stat) continue;
        const source = realDirectory(stat) && realDirectory(present(path.join(directory, '.git')))
            && fs.realpathSync(directory) === directory ? adapters.gitSource(directory) : null;
        if (!source || source.toplevel !== directory || ![`https://github.com/AssistOS-AI/${repository}.git`,
            `https://github.com/AssistOS-AI/${repository}`].includes(source.origin)) fail('managed-source-invalid');
    }
    for (const relative of regenerable.filter(entry => entry.startsWith('.ploinky/'))) {
        const stat = present(path.join(scope.workspace, relative));
        if (!stat || copied.includes(relative)) continue;
        if (relative.startsWith('.ploinky/box/') ? !realDirectory(stat) : !isFile(stat)) fail('unexpected-type');
    }
}

/** Contract 3: every proof of a resumable interrupted redeploy; R7 runs last because it is heavy. */
function proveResume(adapters, scope, backup, containers) {
    const uid = adapters.getuid();
    const fail = (reason, code = 'QA_EXACT_BOX_ABSENT_NOT_RESUMABLE') => refuse(code, { backup: backup.name, reason });
    // R2
    const workspace = present(scope.workspace);
    if (!(realDirectory(workspace) && workspace.uid === uid && fs.realpathSync(scope.workspace) === scope.workspace)) {
        fail('workspace-invalid');
    }
    // R3: the exact name is absent in both engines (the caller's branch); no QA-labelled container runs,
    // and every labelled one is a retained Box, as the Reconcile resume admission requires.
    const labelled = containers.filter(item => item.labels[PATH_HASH_LABEL] === scope.hash);
    if (labelled.some(item => item.running)) fail('qa-container-running');
    if (labelled.some(item => !retainedBoxName(scope, item.name))) fail('unexpected-qa-container');
    // R4
    if (!backup.helpersValid) fail('helpers-invalid');
    const record = new RegExp(`^(podman|docker)\\|([a-f0-9]{64})\\|${escapeRegExp(scope.box)}\\n$`).exec(backup.priorRecord ?? '');
    if (!record) fail('prior-record-mismatch');
    const [, engine, predecessorId] = record;
    if (!backup.quiesceSource) fail('quiesce-source-missing');
    if (backup.policyRestoration) fail('policy-restoration-present');
    // R5
    const retained = containers.filter(item => item.name === `${scope.box}-rollback-${backup.name}`);
    if (retained.length === 0) fail('rollback-box-missing');
    if (retained.length > 1 || containers.some(item => item.id === predecessorId && item !== retained[0])) fail('rollback-box-ambiguous');
    if (retained[0].running !== false) refuse('QA_RETAINED_BOX_RUNNING', { backup: backup.name });
    if (retained[0].engine !== engine || retained[0].id !== predecessorId) fail('rollback-box-mismatch');
    // R6: one read-only root process reads the root-owned preservation receipt.
    const proof = adapters.runPrivileged(adapters.privilegedSource(), ['resume-proof', '--root', scope.backups,
        '--workspace', scope.workspace, '--owner', String(uid), '--backup', backup.name]);
    if (!proof || proof.error || proof.status !== 0) fail(resumeReason(singleJsonLine(proof?.stdout)?.code, 'resume-proof-failed'));
    let copied = null;
    try { ({ copied } = parseResumeProof(proof.stdout, backup.name)); } catch (error) { fail(resumeReason(error.code, 'resume-proof-failed')); }
    // R8
    assertResumeWorkspace(adapters, scope, backup, copied, fail);
    // R7
    let plan = null;
    try { plan = adapters.backupHelperPlan(backup.file); } catch (error) { fail(resumeReason(error?.code, 'helper-plan-failed')); }
    if (!acceptedBackupPlan(plan, predecessorId)) fail('helper-plan-refused');
    return { backup: backup.name, predecessorId, engine };
}

/**
 * Read-only route taken before `select` under the host lock (contract 2). An
 * exact-name Box goes to `select`, unless the newest backup is an unfinished
 * redeploy. Without one, only the proven interrupted-redeploy state resumes;
 * every other state is refused, so nothing falls through into a fresh install
 * or a new redeploy. The container listing is light: names, IDs, run state and
 * labels only.
 */
export function routeDeployment(adapters, scope = QA_SCOPE) {
    adapters.assertHost();
    // R1
    prove(adapters.lockHeld() === true, 'QA_BACKUPS_HOST_LOCK_REQUIRED');
    const containers = adapters.containers();
    prove(Array.isArray(containers) && containers.every(item => item && ['podman', 'docker'].includes(item.engine)
        && FULL_ID.test(item.id || '') && typeof item.name === 'string' && typeof item.running === 'boolean'
        && item.labels !== null && typeof item.labels === 'object'), 'QA_ENGINE_PROBE_FAILED');
    if (containers.some(item => item.running && retainedBoxName(scope, item.name))) refuse('QA_RETAINED_BOX_RUNNING');
    // The same createdAt rules as the rollback target; every dated backup takes part, so a
    // newer attempt of any kind, or a tie, is never skipped in favour of an older backup.
    const dated = inventoryBackups(adapters, scope).filter(item => item.createdAt !== null);
    const newest = dated.filter(item => Date.parse(item.createdAt) === Date.parse(dated[0].createdAt));
    const unfinished = item => item.workspace === 'directory' && !item.marker && !item.restoredSelections;
    if (containers.some(item => item.name === scope.box)) {
        const open = newest.find(unfinished);
        if (open) refuse('QA_REDEPLOY_UNFINISHED', { backup: open.name, reason: 'exact-box-present' });
        return { result: 'routed', route: 'select' };
    }
    const notResumable = (reason, backup) => refuse('QA_EXACT_BOX_ABSENT_NOT_RESUMABLE', backup ? { backup, reason } : { reason });
    if (newest.length === 0) notResumable('no-backup');
    if (newest.length > 1) notResumable('created-at-tie');
    const [candidate] = newest;
    if (candidate.marker) notResumable('rollback-state', candidate.name);
    if (candidate.workspace === null) notResumable('newest-no-workspace', candidate.name);
    if (candidate.workspace !== 'directory') notResumable('backup-workspace-invalid', candidate.name);
    if (candidate.restoredSelections) notResumable('newest-complete', candidate.name);
    return { result: 'routed', route: 'resume', ...proveResume(adapters, scope, candidate, containers) };
}

const commandEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PLOINKY_|CLOUDFLARE_|GIT_)/.test(key)));

export function retentionProductionAdapters(scope = QA_SCOPE) {
    const base = productionAdapters(scope);
    const updates = update.updateProductionAdapters(scope);
    return {
        assertHost: base.assertHost,
        boxes: base.boxes,
        runtime: updates.runtime,
        health: updates.health,
        assertRuntimeReady: typeof update.assertRuntimeReady === 'function' ? update.assertRuntimeReady : undefined,
        getuid: () => process.getuid(),
        lockHeld() {
            const locked = spawnSync('flock', ['-n', '-E', '75', scope.lock, 'true'], { encoding: 'utf8', timeout: 5000 });
            return !locked.error && locked.status === 75;
        },
        privilegedSource: () => fs.readFileSync(new URL('./qa-backups-privileged.mjs', import.meta.url), 'utf8'),
        runPrivileged(source, args) {
            // The sudoers rule admits /usr/bin/node reading its program from stdin.
            const result = spawnSync('sudo', ['-n', '/usr/bin/node', '--input-type=module', '-', ...args], {
                input: source, encoding: 'utf8', timeout: PRIVILEGED_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
                stdio: ['pipe', 'pipe', 'pipe'], env: commandEnv() });
            return { status: result.status, error: Boolean(result.error), stdout: result.stdout };
        },
        removeContainer(engine, id) {
            prove(['podman', 'docker'].includes(engine) && FULL_ID.test(id), 'QA_RETENTION_BOX_REMOVAL_FAILED');
            const result = spawnSync(engine, ['container', 'rm', id], { encoding: 'utf8', timeout: 120_000,
                maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], env: commandEnv() });
            prove(!result.error && result.status === 0, 'QA_RETENTION_BOX_REMOVAL_FAILED');
        },
        // Light summary of every container in each installed engine: no sanitizing and no image probe.
        // An engine that is installed but cannot list or inspect fails the route.
        containers() {
            const result = [];
            for (const engine of ['podman', 'docker']) {
                const installed = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', engine], { encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
                if (installed.status !== 0) continue;
                const call = args => {
                    const output = spawnSync(engine, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
                        stdio: ['ignore', 'pipe', 'pipe'], env: commandEnv() });
                    prove(!output.error && output.status === 0, 'QA_ENGINE_PROBE_FAILED');
                    return output.stdout;
                };
                const ids = call(['container', 'ls', '-aq', '--no-trunc']).split(/\s+/).filter(Boolean);
                prove(ids.every(id => FULL_ID.test(id)) && new Set(ids).size === ids.length, 'QA_ENGINE_PROBE_FAILED');
                if (ids.length === 0) continue;
                const text = call(['container', 'inspect', ...ids]);
                let rows = null;
                try { rows = JSON.parse(text); } catch {}
                prove(Array.isArray(rows) && rows.length === ids.length, 'QA_ENGINE_PROBE_FAILED');
                for (const row of rows) {
                    prove(ids.includes(row?.Id) && typeof row.Name === 'string' && typeof row.State?.Running === 'boolean',
                        'QA_ENGINE_PROBE_FAILED');
                    const labels = row.Config?.Labels;
                    result.push({ engine, id: row.Id, name: row.Name.replace(/^\//, ''), running: row.State.Running,
                        labels: labels && typeof labels === 'object' ? { ...labels } : {} });
                }
            }
            return result;
        },
        gitSource(directory) {
            const git = args => spawnSync('git', ['-c', `safe.directory=${directory}`, '-C', directory, ...args], {
                encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...commandEnv(), GIT_OPTIONAL_LOCKS: '0' } });
            const toplevel = git(['rev-parse', '--show-toplevel']), origin = git(['remote', 'get-url', 'origin']);
            if (toplevel.error || toplevel.status !== 0 || origin.error || origin.status !== 0) return null;
            return { toplevel: toplevel.stdout.trim(), origin: origin.stdout.trim() };
        },
        // R7 runs the backup's own frozen helper with the backup's own Node, as the rollback workflow does.
        backupHelperPlan(backup) {
            const { node, args } = backupHelperCommand(backup, scope);
            let stat = null;
            try { stat = fs.statSync(node); } catch {}
            prove(stat?.isFile() && (stat.mode & 0o111) !== 0, 'QA_RESUME_HELPER_RUNTIME_INVALID');
            const version = spawnSync(node, ['--version'], { encoding: 'utf8', timeout: 30_000,
                stdio: ['ignore', 'pipe', 'pipe'], env: commandEnv() });
            prove(!version.error && version.status === 0 && version.stdout.trim() === BACKUP_NODE_VERSION, 'QA_RESUME_HELPER_RUNTIME_INVALID');
            const result = spawnSync(node, args, { encoding: 'utf8', timeout: BACKUP_HELPER_TIMEOUT_MS,
                maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: commandEnv() });
            return { status: result.status, error: Boolean(result.error), stdout: result.stdout };
        },
    };
}

/** Returns the exit status and the single JSON line; nothing is printed here. */
export async function run(argv, adapters = null, scope = QA_SCOPE) {
    const [mode, ...flags] = argv;
    if (mode === 'route') {
        // Every route failure, including usage, the lock and engine probes, is one refused line.
        try {
            prove(flags.length === 1 && flags[0] === '--lock-held', 'QA_BACKUPS_USAGE_INVALID');
            return { status: 0, output: routeDeployment(adapters || retentionProductionAdapters(scope), scope) };
        } catch (error) {
            return { status: 1, output: { result: 'refused', code: safeCode(error, 'QA_BACKUPS_REJECTED'), ...(error?.refusal || {}) } };
        }
    }
    try {
        const pruneUsage = mode === 'prune' && flags.length === 3 && flags[0] === '--current-id'
            && FULL_ID.test(flags[1]) && flags[2] === '--lock-held';
        const targetUsage = mode === 'rollback-target' && flags.length === 1 && flags[0] === '--lock-held';
        prove(pruneUsage || targetUsage, 'QA_BACKUPS_USAGE_INVALID');
        const selected = adapters || retentionProductionAdapters(scope);
        if (mode === 'prune') return { status: 0, output: await createRetentionService(selected, scope).prune({ currentId: flags[1] }) };
        selected.assertHost();
        prove(selected.lockHeld() === true, 'QA_BACKUPS_HOST_LOCK_REQUIRED');
        return { status: 0, output: selectRollbackTarget(selected, scope) };
    } catch (error) {
        return { status: 1, output: error?.receipt || { result: 'failed', code: safeCode(error, 'QA_BACKUPS_REJECTED') } };
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { status, output } = await run(process.argv.slice(2));
    process.stdout.write(JSON.stringify(output) + '\n');
    process.exitCode = status;
}
