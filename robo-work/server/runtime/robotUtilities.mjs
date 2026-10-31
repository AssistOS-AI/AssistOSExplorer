import { createVerifiedServiceContext, fail } from '../stateProtocol.mjs';
import { VIRTUAL_HOME } from './alaPlan.mjs';

export const UTILITY_DEFAULTS = Object.freeze({ maxPerRobot: 1, maxTotal: 4, deadlineMs: 12000, outputBytes: 512 * 1024, cacheMs: 15000, cacheEntries: 128 });
const AGENTS = ['codex', 'opencode', 'pi', 'claude'];

export function modelUtilityPlan(agent) {
    if (!AGENTS.includes(agent)) fail('invalid_request');
    return { grants: [], skills: [], cwd: VIRTUAL_HOME, channels: {}, env: { HOME: VIRTUAL_HOME },
        argv: ['agent', 'models', agent, '--json', '--home', VIRTUAL_HOME, '--execution-provider', 'protocol'] };
}

export function projectModels(value) {
    if (!Array.isArray(value) || value.length > 4096) fail('runtime_unavailable');
    return value.map((entry) => {
        if (!entry || typeof entry.id !== 'string' || entry.id.length < 1 || entry.id.length > 512 || /[\u0000-\u001f\u007f]/u.test(entry.id)
            || !Array.isArray(entry.efforts) || entry.efforts.length > 32 || !entry.efforts.every((effort) => typeof effort === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(effort))) fail('runtime_unavailable');
        return { id: entry.id, label: entry.id, efforts: entry.efforts,
            ...(entry.efforts.includes(entry.defaultEffort) ? { defaultEffort: entry.defaultEffort } : {}) };
    });
}

function projectStatus(value) {
    if (!Array.isArray(value?.agents) || value.agents.length !== AGENTS.length) fail('runtime_unavailable');
    return { agents: AGENTS.map((name) => {
        const entry = value.agents.find((agent) => agent.name === name);
        if (!entry || typeof entry.available !== 'boolean' || typeof entry.loggedIn !== 'boolean'
            || (entry.version !== null && (typeof entry.version !== 'string' || !/^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/u.test(entry.version)))) fail('runtime_unavailable');
        return { name, available: entry.available, loggedIn: entry.loggedIn, version: entry.version };
    }) };
}

// Called only after the coordinator's robots/get authorization. Cache contains sanitized projections, never HOME bytes.
export function createRobotUtilities({ store, factory, workspaceId, options = {}, now = Date.now }) {
    const limits = { ...UTILITY_DEFAULTS, ...options };
    const context = createVerifiedServiceContext({ workspaceId, scope: 'worker:utilities', ownerId: 'worker:utilities', robotOwnerId: 'worker:utilities', operations: ['adapter_complete'] });
    const cache = new Map();
    const active = new Map();
    let closed = false;

    async function run(robot, operation, agent) {
        const item = { ...store.admitUtility({ robotId: robot.robotId ?? robot.id, maxPerRobot: limits.maxPerRobot, maxTotal: limits.maxTotal }), kind: 'utility', specification: {} };
        let execution;
        let state = 'queued';
        let timer;
        let finish;
        const interrupted = new Promise((_, reject) => { finish = () => reject(new Error('utility_closed')); });
        let settled;
        const record = { stop: finish, done: new Promise((resolve) => { settled = resolve; }) };
        active.set(item.executionId, record);
        let failure = null;
        let setup = null;
        let starting = null;
        let abandoned = false;
        try {
            const work = (async () => {
                setup = operation === 'models'
                    ? factory.open({ item, plan: modelUtilityPlan(agent), context })
                    : factory.openTerminal({ item, context, utility: true });
                execution = await setup;
                execution.lost?.then(finish, finish);
                if (abandoned) throw new Error('utility_ended');
                starting = execution.start({});
                const streams = await starting;
                if (abandoned) throw new Error('utility_ended');
                store.transitionAttempt({ executionId: item.executionId, attemptId: item.attemptId, expectedState: 'queued', nextState: 'running' });
                state = 'running';
                let size = 0;
                const chunks = [];
                const read = async (stream, keep) => {
                    if (!stream) throw new Error('utility_stream_missing');
                    for await (const chunk of stream) {
                        size += chunk.length;
                        if (size > limits.outputBytes) throw new Error('utility_output_limit');
                        if (keep) chunks.push(Buffer.from(chunk));
                    }
                };
                streams.stdin?.end();
                const [exit] = await Promise.all([execution.exited, read(streams.stdout, true), read(streams.stderr, false)]);
                if (exit.exitCode !== 0 || exit.signal) throw new Error('utility_failed');
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                return operation === 'models' ? { agent, models: projectModels(parsed) } : projectStatus(parsed);
            })();
            // Opening and publication are included in the deadline. Wait for setup before ending its ledger, so resources cannot publish
            // after cleanup. Launch operations themselves have the existing sandbox setup deadlines.
            work.catch(() => {});
            const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('utility_timeout')), limits.deadlineMs); });
            try {
                return await Promise.race([work, deadline, interrupted]);
            } catch (error) {
                failure = error;
                throw error;
            }
        } catch (error) {
            failure = error;
            fail('runtime_unavailable');
        } finally {
            abandoned = true;
            clearTimeout(timer);
            if (setup) { try { execution = await setup; } catch { /* no execution */ } }
            if (starting) await starting.catch(() => {});
            const outcome = { classification: failure ? 'failed' : 'completed', outputText: '', data: { utility: operation }, expectedState: state };
            try {
                if (execution) {
                    const ended = await execution.end(outcome);
                    if ((ended?.releaseLog ?? []).some((entry) => entry.outcome === 'quarantined')) fail('resource_quarantined');
                } else {
                    store.beginAttemptEnd(context, { executionId: item.executionId, attemptId: item.attemptId, expectedState: state, outcome: { classification: outcome.classification, outputText: outcome.outputText, data: outcome.data } });
                }
            } finally { active.delete(item.executionId); settled(); }
        }
    }

    return Object.freeze({
        async read(robot, operation, agent) {
            if (closed || !factory || robot.ready !== true) fail('runtime_unavailable');
            if (operation !== 'agent-status' && operation !== 'models') fail('invalid_request');
            if (operation === 'models' && !AGENTS.includes(agent)) fail('invalid_request');
            const key = JSON.stringify([robot.robotId ?? robot.id, robot.revision, operation, agent ?? null]);
            const previous = cache.get(key);
            if (previous && previous.until > now()) return structuredClone(previous.value);
            cache.delete(key);
            const value = await run(robot, operation, agent);
            while (cache.size >= limits.cacheEntries) cache.delete(cache.keys().next().value);
            if (!closed) cache.set(key, { until: now() + limits.cacheMs, value });
            return structuredClone(value);
        },
        async close() {
            closed = true;
            cache.clear();
            for (const record of active.values()) record.stop();
            await Promise.allSettled([...active.values()].map((record) => record.done));
        },
    });
}
