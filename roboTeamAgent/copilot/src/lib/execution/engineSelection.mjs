import { createAlaEngine } from './alaEngine.mjs';
import { createWorkerEngine } from './workerEngine.mjs';
import { COORDINATOR_BASE_ENV, createWorkerCoordinatorHop } from '../../../../server/worker-coordinator/hop.mjs';
import { createWorkerClient } from '../../../../server/worker-coordinator/worker-client.mjs';
import { createRobotProvisioner } from '../../../../server/worker-coordinator/robot-provisioning.mjs';

// The one cutover seam (RoboWork r10 decision M-5). When ROBOTEAM_WORKER_COORDINATOR_BASE is set the
// execution engine is the worker engine, and a worker failure is an explicit error: there is no
// fallback to a local ALA run. The local ALA engine exists only for the unset case, until the
// AI-task end-to-end gate passes.
export const workerModeSelected = (env = process.env) => String(env[COORDINATOR_BASE_ENV] || '').trim() !== '';

// `localOptions` are alaEngine's options, `workerOptions` workerEngine's plus `robotStore` and
// `robotId`. The factories and the hop are test injections.
export function createExecutionEngine({ env = process.env, localOptions, workerOptions, hop = null,
    createLocal = createAlaEngine, createWorker = createWorkerEngine } = {}) {
    if (!workerModeSelected(env)) return createLocal(localOptions);
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
