import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { MIGRATION_ID } from './opencode-home-migration.mjs';
import { robotId, fail } from './robot-paths.mjs';

// Kernel lock: released even after a killed process or a container restart. Never guess that a PID lock is stale.
async function lock(file) {
    const child = spawn('flock', ['--exclusive', '--nonblock', file, 'cat'], { stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error('Another OpenCode migration holds the lock')));
        child.stdout.once('data', resolve);
        child.stdin.on('error', reject);
        child.stdin.write('locked\n');
    }).catch(error => { child.stdin.destroy(); child.kill(); throw error; });
    return () => child.stdin.end();
}

// Complete journals only retire what an earlier run left behind; every other robot needs the OpenCode migration.
async function journalComplete(root, id) {
    try {
        const state = JSON.parse(await fs.readFile(path.join(root, id, 'state.json'), 'utf8'));
        return state?.migration === MIGRATION_ID && state.phase === 'complete';
    } catch { return false; }
}

export function createOpenCodeMigration({ paths, toolCache, homeOperation, alaEntry, log = console.log, lockImpl = lock, now = Date.now }) {
    let ready = false;
    let failed;
    const failures = new Map();
    // A robot is finished when its own step ended, whatever the outcome; its guard no longer waits for the others.
    const finished = new Set();
    let work;
    return {
        status(id) {
            if (!ready && !finished.has(id)) return { id: MIGRATION_ID, state: 'running' };
            return { id: MIGRATION_ID, state: failed || failures.has(id) ? 'failed' : 'complete' };
        },
        guard(id) {
            if (!ready && !finished.has(id)) throw fail('OPENCODE_MIGRATING', 'Robot homes are being upgraded to OpenCode V2. Retry shortly.', 503);
            if (failed || failures.has(id)) throw fail('OPENCODE_MIGRATION_FAILED',
                'OpenCode migration requires attention. Original state is preserved in the migration backup.', 503);
        },
        start() {
            if (work) return work;
            work = (async () => {
                const startedAt = now();
                const root = path.join(paths.dataDir, 'server-state', 'migrations', MIGRATION_ID);
                await fs.mkdir(root, { recursive: true, mode: 0o700 });
                const release = await lockImpl(path.join(root, 'migration.lock'));
                try {
                    const alaRoot = path.dirname(path.dirname(await fs.realpath(alaEntry)));
                    const contract = await import(pathToFileURL(path.join(alaRoot,
                        'src/coding-agents/agents/opencode/v2-contract.mjs')).href);
                    if (!contract.OPENCODE_V2_SUPPORTED) throw new Error('Deploy V2-compatible ALA before migrating RoboWork');
                    // Retain the old executable tree outside tool-cache garbage collection.
                    const savedTools = path.join(root, 'v1-tool-cache');
                    try {
                        await fs.access(path.join(root, 'tools-saved'));
                    } catch (error) {
                        if (error.code !== 'ENOENT') throw error;
                        await fs.rm(savedTools, { recursive: true, force: true });
                        const source = path.join(toolCache.root, 'opencode');
                        await fs.cp(source, savedTools, { recursive: true, verbatimSymlinks: true })
                            .catch(error => { if (error.code !== 'ENOENT') throw error; });
                        await fs.writeFile(path.join(root, 'tools-saved'), '1\n', { flag: 'wx', mode: 0o600 });
                    }
                    const complete = [], pending = [];
                    for (const id of await fs.readdir(paths.robotsDir)) {
                        if (id.startsWith('.')) continue;
                        robotId(id);
                        // Removed robots may retain runs only.
                        try { await fs.access(path.join(paths.robot(id), 'label')); } catch { continue; }
                        (await journalComplete(root, id) ? complete : pending).push(id);
                    }
                    const counts = { retired: 0, absent: 0, authored: 0, customized: 0, unsafe: 0, failed: 0 };
                    const step = async (id, input, wasComplete) => {
                        const backup = path.join(root, id);
                        try {
                            await fs.mkdir(backup, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
                            const result = await homeOperation(id, 'opencode_migrate', { migrationBackup: backup, ...input });
                            if (Object.hasOwn(counts, result.plugin)) counts[result.plugin]++;
                            log(`[opencode-migration] robot=${id} ${result.repeated ? 'already complete' : 'complete'}`);
                        } catch (error) {
                            if (wasComplete) {
                                // The migration finished earlier; only the cleanup failed, and a later start retries it.
                                counts.failed++;
                                log(`[opencode-migration] robot=${id} plugin cleanup failed; migration state remains complete`);
                            } else {
                                failures.set(id, error);
                                log(`[opencode-migration] robot=${id} failed; backup=${backup}`);
                            }
                        } finally { finished.add(id); }
                    };
                    // Finished robots need no OpenCode and no download, so they are released first.
                    for (const id of complete) await step(id, {}, true);
                    if (pending.length) {
                        const tools = await toolCache.prepareCodingAgent('opencode');
                        const binary = path.join(tools.binPath, 'opencode');
                        for (const id of pending) await step(id, { binary }, false);
                    }
                    log(`[opencode-plugin] retired=${counts.retired} absent=${counts.absent} authored=${counts.authored} `
                        + `customized=${counts.customized} unsafe=${counts.unsafe} failed=${counts.failed} ms=${now() - startedAt}`);
                } finally { release(); }
            })().catch(error => {
                failed = error;
                log(`[opencode-migration] blocked: ${error.message}`);
            }).finally(() => { ready = true; });
            return work;
        },
    };
}
