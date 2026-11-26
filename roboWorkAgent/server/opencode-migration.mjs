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

export function createOpenCodeMigration({ paths, toolCache, homeOperation, alaEntry, log = console.log }) {
    let ready = false;
    let failed;
    const failures = new Map();
    let work;
    return {
        status(id) { return { id: MIGRATION_ID, state: !ready ? 'running' : failed || failures.has(id) ? 'failed' : 'complete' }; },
        guard(id) {
            if (!ready) throw fail('OPENCODE_MIGRATING', 'Robot homes are being upgraded to OpenCode V2. Retry shortly.', 503);
            if (failed || failures.has(id)) throw fail('OPENCODE_MIGRATION_FAILED',
                'OpenCode migration requires attention. Original state is preserved in the migration backup.', 503);
        },
        start() {
            if (work) return work;
            work = (async () => {
                const root = path.join(paths.dataDir, 'server-state', 'migrations', MIGRATION_ID);
                await fs.mkdir(root, { recursive: true, mode: 0o700 });
                const release = await lock(path.join(root, 'migration.lock'));
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
                    const tools = await toolCache.prepareCodingAgent('opencode');
                    const template = await toolCache.prepareOpenCodePlugin(tools.versions.opencode);
                    const binary = path.join(tools.binPath, 'opencode');
                    for (const id of await fs.readdir(paths.robotsDir)) {
                        if (id.startsWith('.')) continue;
                        robotId(id);
                        // Removed robots may retain runs only.
                        try { await fs.access(path.join(paths.robot(id), 'label')); } catch { continue; }
                        const backup = path.join(root, id);
                        await fs.mkdir(backup, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
                        try {
                            const result = await homeOperation(id, 'opencode_migrate', { migrationBackup: backup, binary, template });
                            log(`[opencode-migration] robot=${id} ${result.repeated ? 'already complete' : 'complete'}`);
                        } catch (error) {
                            failures.set(id, error);
                            log(`[opencode-migration] robot=${id} failed; backup=${backup}`);
                        }
                    }
                } finally { release(); }
            })().catch(error => {
                failed = error;
                log(`[opencode-migration] blocked: ${error.message}`);
            }).finally(() => { ready = true; });
            return work;
        },
    };
}
