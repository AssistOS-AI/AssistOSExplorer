// The owner of a robot task comes only from the service-set task tag in the child's environment, never from a file
// a robot can write.
export function taskOwnerContext(env = process.env) {
    try {
        const owner = JSON.parse(env.ROBOTEAM_TASK_TAG || 'null')?.ownerPrincipal;
        return typeof owner === 'string' && /^user:.+/u.test(owner) ? { ownerPrincipal: owner } : {};
    } catch { return {}; }
}
