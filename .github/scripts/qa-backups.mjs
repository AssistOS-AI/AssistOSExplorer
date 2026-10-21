#!/usr/bin/env node
// Admin-side QA backup retention and rollback-target selection. The prune runs
// under the host lock inside Reconcile, before the capacity admission, and only
// while the current QA Box is proven ready and healthy. Backup files are
// classified and deleted by qa-backups-privileged.mjs in one root process; this
// side never reads the root-owned receipts. Boxes are removed afterwards, only
// when bound to a removed backup by name and by the ID recorded before deletion.
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
    const priorRecord = new RegExp(`^(podman|docker)\\|([a-f0-9]{64})\\|${scope.box.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

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
 * Read-only. The newest backup that changed QA state is the only target; an
 * ineligible newest backup is refused rather than replaced by an older one.
 */
export function selectRollbackTarget(adapters, scope = QA_SCOPE) {
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
    const boxes = adapters.boxes();
    const predecessorPattern = new RegExp(`^(?:podman|docker)\\|([a-f0-9]{64})\\|${scope.box.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?$`);
    const candidates = backups.map(({ name, file }) => {
        // Only admin-owned files are read; root-owned receipts are checked with lstat alone.
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
        let predecessorId = null;
        const prior = inside('prior-containers.txt');
        if (isFile(prior) && prior.uid === uid && prior.size <= 4096) {
            predecessorId = predecessorPattern.exec(fs.readFileSync(path.join(file, 'prior-containers.txt'), 'utf8'))?.[1] || null;
        }
        const marker = fs.readdirSync(file).some(entry => BACKUP_INNER_ENTRIES.rollbackMarkers
            .some(item => typeof item === 'string' ? item === entry : item.test(entry)));
        // A stopped exact-name predecessor is stop evidence: Reconcile can stop it without a quiesce log.
        // So is the moved live workspace, which exists before preservation.json is written.
        const stopped = predecessorId !== null && boxes.some(item => item.box.id === predecessorId
            && item.box.name === scope.box && item.box.running === false);
        const stopEvidence = Boolean(inside('quiesce.log') || present(`${file}-quiesce.log`) || inside('preservation.json')
            || inside('workspace') || stopped);
        const helpers = inside('helpers');
        const helpersValid = Boolean(helpers?.isDirectory() && !helpers.isSymbolicLink()
            && isFile(inside('helpers/node-runtime-path')) && isFile(inside('helpers/rollback-explorer-qa.mjs')));
        let reason = null;
        if (createdAt === null) reason = 'undated';
        else if (marker) reason = 'rollback-already-attempted';
        else if (!stopEvidence) reason = 'no-stop-evidence';
        else if (!helpersValid) reason = 'helpers-missing';
        else if (!predecessorId) reason = 'no-predecessor';
        return { name, createdAt, eligible: reason === null, reason, predecessorId };
    }).sort((left, right) => (right.createdAt ? Date.parse(right.createdAt) : -Infinity)
        - (left.createdAt ? Date.parse(left.createdAt) : -Infinity) || left.name.localeCompare(right.name));
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
    };
}

/** Returns the exit status and the single JSON line; nothing is printed here. */
export async function run(argv, adapters = null, scope = QA_SCOPE) {
    try {
        const [mode, ...flags] = argv;
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
