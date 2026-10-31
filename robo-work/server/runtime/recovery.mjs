import { walkOrder } from '../execution/recoveryWalk.mjs';

// Generation recovery at worker start (plan section 5.5): roll the generation, settle every blocker of the prior one, and
// complete the recovery. It follows recoveryWalk.recoverGeneration, with one addition: a `preparation` blocker (the S1 record of
// an interrupted provision or configure, created by the store itself) names no process, mount or file that the walker could
// look for, and the walker treats a kind it does not know as unprovable, which would quarantine the robot for the full
// release deadline. The rollover has already marked such a robot `failed`/`uncertain` and dropped the preparation, so
// its blocker is settled `released` here, and the walker handles every other kind.
export async function recoverWorkerGeneration({ state, walker }) {
    const started = state.beginGenerationRecovery(state.generationId);
    const outcomes = [];
    for (const blocker of walkOrder(started.unsettledBlockers)) {
        const outcome = blocker.kind === 'preparation' ? 'released' : await walker.walk(blocker, { recovery: true });
        state.settleResource({ resourceId: blocker.resourceId, generationId: blocker.generationId, outcome });
        outcomes.push({ resourceId: blocker.resourceId, kind: blocker.kind, outcome });
    }
    const completed = state.completeGenerationRecovery(started.generationId);
    return { generationId: started.generationId, priorGenerationId: started.priorGenerationId, outcomes, completed };
}
