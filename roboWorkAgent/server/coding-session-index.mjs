import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Service-owned metadata only. Native histories remain authoritative and are read by
// the confined home helper. No user credentials, prompts or terminal output are stored.
export function createCodingSessionIndex({ root, ensureDirectory, robots, agents, history, now = Date.now, defer = (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; } }) {
    const locks = new Map(), jobs = new Map(), launchTimers = new Map(), maintenance = new Map();
    const fullInterval = 15 * 60_000;
    let queue = Promise.resolve();
    const key = (robotId, codingAgent) => `${robotId}/${codingAgent}`;
    const fileFor = directory => path.join(root, `${createHash('sha256').update(directory).digest('hex')}.json`);
    async function transaction(directory, change) {
        const previous = locks.get(directory) || Promise.resolve();
        const operation = previous.catch(() => {}).then(async () => {
            await ensureDirectory();
            const file = fileFor(directory);
            let state;
            try {
                const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
                try {
                    const stat = await handle.stat();
                    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid coding session index');
                    state = JSON.parse(await handle.readFile('utf8'));
                } finally { await handle.close(); }
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                state = { version: 1, directory, initialized: false, checkedAt: 0, sources: {}, error: null };
            }
            if (state.version !== 1 || state.directory !== directory || !state.sources || typeof state.sources !== 'object'
                || Array.isArray(state.sources)) throw new Error('Invalid coding session index');
            if (change) {
                change(state);
                const temporary = path.join(root, `.${randomUUID()}.tmp`);
                try {
                    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
                    await fs.rename(temporary, file);
                } finally { await fs.rm(temporary, { force: true }); }
            }
            return state;
        });
        locks.set(directory, operation);
        void operation.finally(() => { if (locks.get(directory) === operation) locks.delete(directory); }).catch(() => {});
        return operation;
    }
    async function record(directory, robot, codingAgent, sessions) {
        await transaction(directory, state => {
            const id = key(robot.id, codingAgent);
            const saved = new Map((state.sources[id]?.sessions || []).map(row => [row.id, row]));
            for (const row of sessions) saved.set(row.id, { id: row.id, title: String(row.title || row.id).slice(0, 512),
                createdAt: row.createdAt, updatedAt: row.updatedAt });
            state.sources[id] = { ...state.sources[id], robotId: robot.id, robotName: robot.name || robot.id,
                codingAgent, sessions: [...saved.values()], checkedAt: now(), error: null };
        });
    }
    async function scan(directory, full) {
        const available = await robots();
        const ids = new Set(available.map(robot => robot.id));
        const state = await transaction(directory, value => {
            value.error = null;
            for (const id of Object.keys(value.sources)) if (!ids.has(value.sources[id].robotId)) delete value.sources[id];
        });
        for (const robot of available) {
            for (const codingAgent of agents) {
                const source = state.sources[key(robot.id, codingAgent)];
                if (!full && (!source || !(source.tracked || source.sessions?.length || source.error))) continue;
                try { await record(directory, robot, codingAgent, await history(robot.id, codingAgent, directory)); }
                catch {
                    await transaction(directory, value => {
                        const id = key(robot.id, codingAgent);
                        value.sources[id] = { ...value.sources[id], robotId: robot.id, robotName: robot.name || robot.id,
                            codingAgent, error: 'History unavailable', checkedAt: now() };
                    });
                }
            }
        }
        await transaction(directory, value => { if (full) { value.initialized = true; value.fullCheckedAt = now(); } value.checkedAt = now(); });
    }
    function schedule(directory, full) {
        const existing = jobs.get(directory);
        if (existing) {
            if (full && !existing.full) existing.upgrade = true;
            return existing.promise;
        }
        const job = { full, upgrade: false };
        job.promise = queue.catch(() => {}).then(async () => {
            await scan(directory, job.full);
            if (job.upgrade) { job.full = true; await scan(directory, true); }
        }).catch(async () => {
            await transaction(directory, value => { value.error = 'Index update failed'; value.checkedAt = now(); });
        });
        jobs.set(directory, job);
        queue = job.promise;
        void job.promise.finally(() => { if (jobs.get(directory) === job) jobs.delete(directory); }).catch(() => {});
        return job.promise;
    }
    function maintain(directory) {
        if (maintenance.has(directory)) return;
        maintenance.set(directory, defer(() => {
            void schedule(directory, true).catch(() => {}).finally(() => {
                maintenance.delete(directory);
                maintain(directory);
            });
        }, fullInterval));
    }
    async function list(directory) {
        const state = await transaction(directory);
        // Import legacy histories once. Existing indexes are snapshots: their age
        // never turns a list request into a refresh or upgrades an active job.
        if (!state.initialized && !state.error) void schedule(directory, true).catch(() => {});
        maintain(directory);
        const sources = Object.values(state.sources);
        return { ok: true, sessions: sources.flatMap(source => (source.sessions || []).map(row => ({ ...row,
            robotId: source.robotId, robotName: source.robotName, codingAgent: source.codingAgent }))),
            refreshing: jobs.has(directory), initialized: state.initialized,
            errors: [...(state.error ? [state.error] : []), ...sources.filter(source => source.error).map(source => `${source.robotName} / ${source.codingAgent}`)] };
    }
    async function launched(directory, robot, codingAgent) {
        await transaction(directory, state => {
            const id = key(robot.id, codingAgent);
            state.sources[id] = { ...state.sources[id], robotId: robot.id, robotName: robot.name || robot.id,
                codingAgent, tracked: true };
            state.error = null;
        });
        for (const timer of launchTimers.get(directory) || []) clearTimeout(timer);
        launchTimers.set(directory, [2000, 30000, 120000].map(delay => defer(() => {
            void schedule(directory, false).catch(() => {});
            if (delay === 120000) launchTimers.delete(directory);
        }, delay)));
    }
    return { list, record, launched, idle: async () => { await queue; } };
}
