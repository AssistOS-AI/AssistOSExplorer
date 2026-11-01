import { fail } from './robot-paths.mjs';

export function authorizeCaller(payload, expected = process.env.ROBOWORK_CONTROLLER_ID || 'agent:AchillesIDE/roboTeamAgent') {
    const grant = payload?.metadata?.invocation;
    if (!grant || grant.sub !== expected || grant.actor?.kind !== 'agent' || grant.actor.id !== expected
        || grant.usr || grant.user || grant.delegation || payload.metadata.user) {
        throw fail('CALLER_REFUSED', 'Only the RoboTeam controller acting on its own behalf may call RoboWork', 403);
    }
}
