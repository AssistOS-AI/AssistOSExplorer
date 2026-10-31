import { createWorkerEngine } from './workerEngine.mjs';
import { COORDINATOR_BASE_ENV, createWorkerCoordinatorHop } from '../../../../server/worker-coordinator/hop.mjs';
import { workerNotConfiguredError } from '../../../../server/worker-coordinator/errors.mjs';
import { createWorkerClient } from '../../../../server/worker-coordinator/worker-client.mjs';
import { createRobotProvisioner } from '../../../../server/worker-coordinator/robot-provisioning.mjs';

// The execution seam (RoboWork r10 decision M-5, R08). The worker engine is the only engine: RoboTeam has no local ALA execution
// path and no fallback to one. When ROBOTEAM_WORKER_COORDINATOR_BASE is not set, the engine that is returned refuses every turn and
// model call with the `worker_not_configured` error, so a misconfigured deployment fails explicitly and never runs anything locally.
export const workerModeSelected = (env = process.env) => String(env[COORDINATOR_BASE_ENV] || '').trim() !== '';

// The engine of an unconfigured deployment: the same interface as the worker engine, starting nothing.
export function createUnconfiguredEngine() {
    const refuse = async () => { throw workerNotConfiguredError(); };
    return Object.freeze({
        executeTurn: refuse,
        getModel: refuse,
        setModel: refuse,
        listModels: refuse,
        async stopTurn() { return { delivered: false, code: 'not_running', message: 'Nothing is running to stop.' }; },
        async close() {},
    });
}

// `workerOptions` are workerEngine's plus `robotStore` and `robotId`. `createWorker` and the hop are test injections.
export function createExecutionEngine({ env = process.env, workerOptions, hop = null, createWorker = createWorkerEngine } = {}) {
    if (!workerModeSelected(env)) return createUnconfiguredEngine();
    const { robotStore, robotId, ...engineOptions } = workerOptions || {};
    if (!robotStore || !robotId) throw new Error('Worker execution requires the RoboTeam robot context.');
    const client = createWorkerClient({ hop: hop || createWorkerCoordinatorHop({ env }) });
    return createWorker({ ...engineOptions, client, provisioner: createRobotProvisioner({ client, robotStore }),
        getRobot: async () => {
            const robot = await robotStore.get(robotId);
            if (!robot) throw new Error('The robot no longer exists.');
            return robot;
        } });
}
