// Robot deletion across RoboTeam and the worker (decision M-29, F12). Every local precondition is checked BEFORE the worker is asked,
// because once the worker has accepted the deletion it cannot be undone and RoboTeam's record must follow it. A precondition that
// fails is a conflict (409) and nothing has been deleted anywhere. If the local deletion still fails after the worker accepted
// (something started in between), it is retried briefly and then settled by an answer that says what remains and that deleting
// again finishes it: the worker's deletion is idempotent, so the two never disagree for long and a precondition is never a 500.

const SETTLE_ATTEMPTS = 3;
const SETTLE_DELAY_MS = 250;

const conflict = (message, extra = {}) => Object.assign(new Error(message), { statusCode: 409, ...extra });

export async function deleteRobotEverywhere({ robot, runtimeManager, robotStore, removeOnWorker, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    attempts = SETTLE_ATTEMPTS, delayMs = SETTLE_DELAY_MS }) {
    // 1. Local preconditions: the workstation and tasks, then the manager's own state, then the robot chat helper.
    const status = runtimeManager.status(robot.id);
    if (status.state !== 'stopped' || runtimeManager.hasUnfinishedTasks?.(robot.id)
        || ['queued', 'starting', 'running', 'pausing'].includes(status.task?.state)) {
        throw conflict('stop the robot before deleting it');
    }
    runtimeManager.assertDeletable?.(robot.id);
    await robotStore.assertDeletable?.(robot.id);

    // 2. The worker decides next: busy work refuses the delete and everything stays as it is.
    if (removeOnWorker) {
        try {
            await removeOnWorker(robot);
        } catch (error) {
            if (error?.code === 'robot_busy') throw conflict('the robot has running or unsettled work; stop it first', { code: 'robot_busy' });
            throw error;
        }
    }

    // 3. Only after the worker accepted is RoboTeam's own record removed, retried while a local precondition is the reason it fails.
    const remove = () => (runtimeManager.deleteRobot ? runtimeManager.deleteRobot(robot.id, () => robotStore.delete(robot.id)) : robotStore.delete(robot.id));
    let last;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            await remove();
            return { worker: Boolean(removeOnWorker) };
        } catch (error) {
            if (error?.statusCode !== 409) throw error;
            last = error;
            if (attempt + 1 < attempts) await sleep(delayMs);
        }
    }
    throw conflict(`The worker has already deleted this robot, but RoboTeam could not remove its own record yet (${last.message}). Delete it again to finish.`,
        { code: 'robot_delete_incomplete' });
}
