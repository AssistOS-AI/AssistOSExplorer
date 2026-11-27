import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { MIGRATION_ID } from './opencode-home-migration.mjs';
import { robotId, fail } from './robot-paths.mjs';

// Kernel lock: released even after a killed process or a container restart. Never guess that a PID lock is stale.
// A held lock rejects with code LOCK_HELD; the returned release resolves once the holder has really exited.
async function lock(file) {
    const child = spawn('flock', ['--exclusive', '--nonblock', file, 'cat'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let exited = false;
    const gone = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
    await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(Object.assign(new Error('Another OpenCode migration holds the lock'), { code: 'LOCK_HELD' })));
        child.stdout.once('data', resolve);
        child.stdin.on('error', reject);
        child.stdin.write('locked\n');
    }).catch(error => { child.stdin.destroy(); child.kill(); throw error; });
    return async () => { if (!exited) child.stdin.end(); await gone; };
}

// Complete journals only retire what an earlier run left behind; every other robot needs the OpenCode migration.
async function journalComplete(root, id) {
    try {
        const state = JSON.parse(await fs.readFile(path.join(root, id, 'state.json'), 'utf8'));
        return state?.migration === MIGRATION_ID && state.phase === 'complete';
    } catch { return false; }
}

const RETRY_INTERVAL_MS = 10 * 60 * 1000;
const RETRY_REQUEST_MS = 60 * 1000;
// Another process (an operator's prune, a second start) may hold the lock briefly; the service waits for it instead of failing every robot.
const LOCK_WAIT_MS = 10 * 60 * 1000;
const LOCK_RETRY_MS = 5 * 1000;

// `lockImpl`, `retryIntervalMs`, `retryRequestMs`, `lockWaitMs`, `lockRetryMs` and `now` exist for tests.
export function createOpenCodeMigration({ paths, toolCache, homeOperation, alaEntry, log = console.log, lockImpl = lock, now = Date.now,
    retryIntervalMs = RETRY_INTERVAL_MS, retryRequestMs = RETRY_REQUEST_MS, lockWaitMs = LOCK_WAIT_MS, lockRetryMs = LOCK_RETRY_MS }) {
    let ready = false;
    let failed;
    const failures = new Map();
    // A robot is finished when its own step ended, whatever the outcome; its guard no longer waits for the others.
    const finished = new Set();
    // Robots whose own step does not fit the disk now, with the reason; they are retried until it does.
    const paused = new Map();
    const retrying = new Set();
    const requested = new Map();
    const root = path.join(paths.dataDir, 'server-state', 'migrations', MIGRATION_ID);
    let tools;
    let timer;
    let work;

    // The OpenCode executable every non-complete robot needs. The tool cache reuses a usable generation without checking the
    // disk and refuses a real installation below its floor (code INSUFFICIENT_SPACE); only then do the robots wait.
    async function prepareTools() {
        try {
            const prepared = await toolCache.prepareCodingAgent('opencode');
            tools = { binary: path.join(prepared.binPath, 'opencode') };
            return tools;
        } catch (error) {
            if (error?.code === 'INSUFFICIENT_SPACE') return { reason: 'INSUFFICIENT_SPACE', neededBytes: error.neededBytes, freeBytes: error.freeBytes };
            throw error;
        }
    }

    function pause(id, details) {
        const { reason, neededBytes, freeBytes: free } = details;
        paused.set(id, { reason, neededBytes, freeBytes: free });
        finished.add(id);
        log(`[opencode-migration] robot=${id} paused: ${reason} needed=${neededBytes} free=${free}`);
        if (ready) schedule();
    }

    // One robot's step. Returns 'paused' when it does not fit the disk, 'failed' on an error and 'done' otherwise.
    async function step(id, input, wasComplete, counts) {
        const backup = path.join(root, id);
        try {
            await fs.mkdir(backup, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
            const result = await homeOperation(id, 'opencode_migrate', { migrationBackup: backup, ...input });
            if (result.phase === 'deferred') { pause(id, result); return 'paused'; }
            if (counts && Object.hasOwn(counts, result.plugin)) counts[result.plugin]++;
            paused.delete(id);
            log(`[opencode-migration] robot=${id} ${result.repeated ? 'already complete' : 'complete'}`);
            // A home left alone is not an error, but an operator needs to know why.
            if (['failed', 'customized', 'unsafe'].includes(result.plugin)) {
                log(`[opencode-migration] robot=${id} plugin tree left alone (${result.plugin})${result.pluginDetail ? `: ${result.pluginDetail}` : ''}`);
            }
            return 'done';
        } catch (error) {
            if (wasComplete) {
                // The migration finished earlier; only the cleanup failed, and a later start retries it.
                if (counts) counts.failed++;
                log(`[opencode-migration] robot=${id} plugin cleanup failed (${error?.code || 'FAILED'}); migration state remains complete`);
                return 'done';
            }
            paused.delete(id);
            failures.set(id, error);
            log(`[opencode-migration] robot=${id} failed; backup=${backup}`);
            return 'failed';
        } finally { if (!paused.has(id)) finished.add(id); }
    }

    // Retries never overlap inside this process, so they never contend for the kernel lock with one another.
    let queue = Promise.resolve();

    // Re-runs one paused robot's step under the kernel lock. Never rejects; a robot that still does not fit stays paused.
    function retry(id) {
        if (!ready || !paused.has(id) || retrying.has(id)) return Promise.resolve(false);
        retrying.add(id);
        const attempt = queue.then(() => attemptResume(id));
        queue = attempt.catch(() => {});
        return attempt;
    }

    async function attemptResume(id) {
        let release;
        try {
            release = await lockImpl(path.join(root, 'migration.lock'));
            if (!paused.has(id)) return false;
            const prepared = tools ?? await prepareTools();
            if (!prepared.binary) { log(`[opencode-migration] robot=${id} still paused: ${prepared.reason} needed=${prepared.neededBytes} free=${prepared.freeBytes}`); return false; }
            const outcome = await step(id, { binary: prepared.binary }, false);
            if (outcome === 'done') log(`[opencode-migration] robot=${id} resumed`);
            return outcome === 'done';
        } catch (error) {
            log(`[opencode-migration] robot=${id} resume attempt failed: ${error?.code || error?.message}`);
            return false;
        } finally {
            await release?.();
            retrying.delete(id);
            if (!paused.has(id)) requested.delete(id);
            if (!paused.size && timer) { clearInterval(timer); timer = undefined; }
        }
    }

    async function retryPaused() {
        for (const id of [...paused.keys()]) await retry(id);
    }

    function schedule() {
        if (timer || !paused.size) return;
        timer = setInterval(() => { void retryPaused(); }, retryIntervalMs);
        timer.unref();
    }

    return {
        status(id) {
            if (paused.has(id)) return { id: MIGRATION_ID, state: 'paused' };
            if (!ready && !finished.has(id)) return { id: MIGRATION_ID, state: 'running' };
            return { id: MIGRATION_ID, state: failed || failures.has(id) ? 'failed' : 'complete' };
        },
        guard(id) {
            if (paused.has(id)) {
                // A request for a paused robot is also the moment to look again, at most once a minute per robot.
                if (ready && !retrying.has(id) && now() - (requested.get(id) ?? -Infinity) >= retryRequestMs) {
                    requested.set(id, now());
                    void retry(id);
                }
                throw fail('OPENCODE_MIGRATION_PAUSED',
                    'OpenCode migration for this robot is paused for lack of disk space. It resumes by itself when space is available.', 503);
            }
            if (!ready && !finished.has(id)) throw fail('OPENCODE_MIGRATING', 'Robot homes are being upgraded to OpenCode V2. Retry shortly.', 503);
            if (failed || failures.has(id)) throw fail('OPENCODE_MIGRATION_FAILED',
                'OpenCode migration requires attention. Original state is preserved in the migration backup.', 503);
        },
        retryPaused,
        close() { if (timer) clearInterval(timer); timer = undefined; },
        start() {
            if (work) return work;
            work = (async () => {
                const startedAt = now();
                await fs.mkdir(root, { recursive: true, mode: 0o700 });
                let release;
                for (let waited = 0; ; waited += lockRetryMs) {
                    try { release = await lockImpl(path.join(root, 'migration.lock')); break; } catch (error) {
                        if (error?.code !== 'LOCK_HELD' || waited >= lockWaitMs) throw error;
                        if (waited === 0) log('[opencode-migration] waiting for migration.lock, held by another process');
                        await delay(lockRetryMs);
                    }
                }
                try {
                    const alaRoot = path.dirname(path.dirname(await fs.realpath(alaEntry)));
                    const contract = await import(pathToFileURL(path.join(alaRoot,
                        'src/coding-agents/agents/opencode/v2-contract.mjs')).href);
                    if (!contract.OPENCODE_V2_SUPPORTED) throw new Error('Deploy V2-compatible ALA before migrating RoboWork');
                    const complete = [], pending = [];
                    for (const id of await fs.readdir(paths.robotsDir)) {
                        if (id.startsWith('.')) continue;
                        robotId(id);
                        // Removed robots may retain runs only.
                        try { await fs.access(path.join(paths.robot(id), 'label')); } catch { continue; }
                        (await journalComplete(root, id) ? complete : pending).push(id);
                    }
                    const counts = { retired: 0, absent: 0, authored: 0, customized: 0, unsafe: 0, failed: 0 };
                    // Finished robots need no OpenCode and no download, so they are released first.
                    for (const id of complete) await step(id, {}, true, counts);
                    if (pending.length) {
                        const prepared = await prepareTools();
                        if (prepared.binary) {
                            for (const id of pending) await step(id, { binary: prepared.binary }, false, counts);
                        } else {
                            // Below the floor nothing is downloaded: the robots that need OpenCode wait, the others are unaffected.
                            for (const id of pending) pause(id, prepared);
                        }
                    }
                    log(`[opencode-plugin] retired=${counts.retired} absent=${counts.absent} authored=${counts.authored} `
                        + `customized=${counts.customized} unsafe=${counts.unsafe} failed=${counts.failed} ms=${now() - startedAt}`);
                } finally { await release(); }
            })().catch(error => {
                failed = error;
                log(`[opencode-migration] blocked: ${error.message}`);
            }).finally(() => { ready = true; schedule(); });
            return work;
        },
    };
}
