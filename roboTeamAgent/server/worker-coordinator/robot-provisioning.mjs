import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerError } from './worker-client.mjs';
import { DEFAULT_OPENCODE_MODEL } from '../agent-model-config.mjs';

// RoboTeam's robot provisioning client (RoboWork r10 decision M-6, plan section 6). RoboTeam keeps
// the desired catalog metadata; the worker owns the robot HOME and the effective revision. The
// worker mints its own robot ID: RoboTeam records it in the robot's metadata (`worker.robotId`) the
// moment the provision receipt returns, and never creates a second worker robot for one RoboTeam
// robot. Lifecycle calls need a verified administrator grant; reads do not.
//
// Operation IDs are deterministic (22 base64url characters of a SHA-256 over the RoboTeam robot,
// the step and the exact desired configuration), so a retry after a lost reply returns the recorded
// receipt and a changed configuration is a new operation.

const READY_TIMEOUT_MS = 60000;
const POLL_MS = 250;
const POLL_MAX_MS = 2000;
const LIFECYCLE_ATTEMPTS = 2;

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export const configurationDigest = (configuration) => crypto.createHash('sha256').update(canonical(configuration)).digest('hex');

export function lifecycleOperationId(kind, ...parts) {
    return crypto.createHash('sha256').update(`roboteam/robot-${kind}/v1\n${parts.join('\n')}`).digest('base64url').slice(0, 22);
}

// The free default model of each coding agent when the user picked none (DS002: OpenCode's free native model, so a
// headless run never falls back to whatever model OpenCode picks on its own). A model the user chose is never
// replaced by it.
export const DEFAULT_MODELS = Object.freeze({ opencode: DEFAULT_OPENCODE_MODEL });

// The worker's robot configuration: `{backend, settings}`. A robot with several coding agents leaves the choice to
// ALA (`auto`). A one-agent robot sends the model and effort the user chose (no `modelSource`), or else the
// agent's free default marked `modelSource: 'default'`, so the robot's settings and the UI never show a default as the
// user's choice. A several-agent robot sends the defaults of its agents as a `models` map.
export function desiredConfiguration(robot) {
    const agents = Array.isArray(robot.codingAgents) ? [...robot.codingAgents] : [];
    const settings = { codingAgents: agents };
    if (agents.length === 1) {
        const selection = robot.selection && typeof robot.selection === 'object' ? robot.selection : {};
        if (typeof selection.model === 'string' && selection.model) {
            settings.model = selection.model;
            if (typeof selection.effort === 'string' && selection.effort) settings.effort = selection.effort;
        } else if (DEFAULT_MODELS[agents[0]]) {
            settings.model = DEFAULT_MODELS[agents[0]];
            settings.modelSource = 'default';
        }
    } else {
        const defaults = Object.fromEntries(agents.filter((agent) => DEFAULT_MODELS[agent]).map((agent) => [agent, DEFAULT_MODELS[agent]]));
        if (Object.keys(defaults).length) {
            settings.models = defaults;
            settings.modelSource = 'default';
        }
    }
    return { backend: agents.length === 1 ? agents[0] : 'auto', settings };
}

const sameConfiguration = (left, right) => canonical(left) === canonical(right);

// `client` is a worker client (worker-client.mjs); `robotStore.withRobot(id, (robot, save) => ...)`
// persists the worker robot ID. `sleep` and the timeouts are test injections.
export function createRobotProvisioner({ client, robotStore, readyTimeoutMs = READY_TIMEOUT_MS, sleep = delay, now = Date.now } = {}) {
    if (!client || !robotStore) throw new TypeError('A worker client and a robot store are required.');

    async function bind(robot, workerRobotId) {
        await robotStore.withRobot(robot.id, async (current, save) => {
            if (current.worker?.robotId && current.worker.robotId !== workerRobotId) throw new WorkerError('worker_robot_conflict', 409);
            if (!current.worker?.robotId) await save({ ...current, worker: { ...(current.worker || {}), robotId: workerRobotId } });
        });
    }

    // A lifecycle call retried once on a lost reply: the deterministic operation ID makes the retry
    // return the recorded receipt rather than repeat the effect.
    async function lifecycle(call) {
        let last;
        for (let attempt = 0; attempt < LIFECYCLE_ATTEMPTS; attempt += 1) {
            try {
                return await call();
            } catch (error) {
                last = error;
                if (!(error instanceof WorkerError) || error.code !== 'worker_reply_unknown') throw error;
            }
        }
        throw last;
    }

    async function provision(robot, auth) {
        const configuration = desiredConfiguration(robot);
        const receipt = await lifecycle(() => client.provision({
            operationId: lifecycleOperationId('provision', robot.id, configurationDigest(configuration)),
            name: robot.name, configuration,
        }, auth));
        if (typeof receipt?.robotId !== 'string') throw new WorkerError('worker_reply_unknown', 503);
        await bind(robot, receipt.robotId);
        return receipt.robotId;
    }

    async function configure(robot, workerRobotId, view, auth) {
        const configuration = desiredConfiguration(robot);
        await lifecycle(() => client.configure({
            operationId: lifecycleOperationId('configure', robot.id, workerRobotId, view.revision, configurationDigest(configuration)),
            robotId: workerRobotId, expectedRevision: view.revision, configuration,
        }, auth));
    }

    // Polls robots/get until the worker reports the robot ready with the desired configuration, a
    // failed preparation, or the bound ends. Never provisions or configures again.
    async function awaitReady(robot, workerRobotId, auth) {
        const configuration = desiredConfiguration(robot);
        const deadline = now() + readyTimeoutMs;
        let wait = POLL_MS;
        for (;;) {
            const view = await client.getRobot(workerRobotId, auth);
            if (view.ready === true && view.preparing === false && sameConfiguration(view.configuration, configuration)) {
                return { robotId: workerRobotId, configRevision: view.revision, configuration: view.configuration };
            }
            if (!view.preparing && view.lifecycle === 'failed') throw new WorkerError('worker_robot_failed', 503, { reason: view.reason || null });
            if (!view.preparing && view.lifecycle === 'ready' && !sameConfiguration(view.configuration, configuration)) {
                throw new WorkerError('worker_robot_stale', 409);
            }
            if (now() >= deadline) throw new WorkerError('worker_robot_not_ready', 503);
            await sleep(wait);
            wait = Math.min(POLL_MAX_MS, wait * 2);
        }
    }

    // ensureRobotReady: read the worker robot; provision it when RoboTeam has none recorded and the
    // caller is an administrator; configure it when its configuration is stale; then wait, bounded.
    // `auth` is `{grant}` for an administrator or user (reads work with any evidence, and for the
    // background row with `{}`), so a missing robot without an administrator grant is an explicit
    // refusal, not a silent creation.
    async function ensureReady(robot, auth = {}) {
        let workerRobotId = robot.worker?.robotId || null;
        if (!workerRobotId) {
            if (!auth.grant) throw new WorkerError('worker_robot_not_provisioned', 409);
            workerRobotId = await provision(robot, auth);
        }
        let view;
        try {
            view = await client.getRobot(workerRobotId, auth);
        } catch (error) {
            if (error instanceof WorkerError && error.code === 'not_found') throw new WorkerError('worker_robot_missing', 409);
            throw error;
        }
        if (!view.preparing && !sameConfiguration(view.configuration, desiredConfiguration(robot))) {
            if (!auth.grant) throw new WorkerError('worker_robot_stale', 409);
            await configure(robot, workerRobotId, view, auth);
        }
        return awaitReady(robot, workerRobotId, auth);
    }

    return Object.freeze({ ensureReady, provision, desiredConfiguration });
}
