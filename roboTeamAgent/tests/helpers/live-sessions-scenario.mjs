import { LiveSessionsRegistry } from '../../server/live-sessions/registry.mjs';

// A registry holding one run for every row shape RoboTeam produces: each kind,
// owner state and live or ended status, URLs, exits with code and signal, and
// text that needs cleaning. Owned runs belong to user:member-1.
export const SCENARIO_OWNER = 'user:member-1';
export const URL_BASE = '/base-agent-additional-server/roboTeamAgent/3001';
export const SOURCE_BASE = `${URL_BASE}/api/live-sessions`;

export function liveSessionsScenario({ log = () => {} } = {}) {
    const registry = new LiveSessionsRegistry({ log, urlBase: URL_BASE });
    const outcomes = new Map();
    const control = (id) => ({
        message: async (text) => {
            const outcome = outcomes.get(text) || 'delivered';
            if (outcome === 'delivered' || outcome === 'queued') return outcome;
            throw Object.assign(new Error(`outcome ${outcome}`), { liveOutcome: outcome });
        },
        stop: async () => { outcomes.set(`stopped:${id}`, true); },
    });
    const admit = (input) => registry.admit({ controls: control(input.title), ...input }).id;
    const runs = {
        robotTask: admit({ kind: 'robot-task', title: 'Robot task · Builder', detail: 'CLI task', cwdDisplay: 'project/app', access: 'rw',
            ownerState: 'verified', ownerPrincipal: SCENARIO_OWNER, transcript: async () => 'robot task transcript' }),
        phase: admit({ kind: 'workflow-phase', title: 'Workflow phase · Release', detail: 'Robot Builder · Stop pauses the whole workflow',
            cwdDisplay: 'workflow-runs/run-1', access: 'rw', ownerState: 'system', transcript: async () => 'phase log' }),
        turn: admit({ kind: 'copilot-turn', title: 'Copilot turn\twith\u0007control characters', detail: 'Robot default', cwdDisplay: 'é'.repeat(3000),
            ownerState: 'unverified' }),
        task: admit({ kind: 'copilot-task', title: 'Delegated task', ownerState: 'verified', ownerPrincipal: SCENARIO_OWNER }),
        waiting: admit({ kind: 'robot-task', title: 'Waiting task', ownerState: 'verified', ownerPrincipal: SCENARIO_OWNER, status: 'waiting' }),
        finished: admit({ kind: 'robot-task', title: 'Finished task', ownerState: 'verified', ownerPrincipal: SCENARIO_OWNER, transcript: async () => 'done' }),
        failed: admit({ kind: 'workflow-phase', title: 'Failed phase', ownerState: 'system' }),
        stopped: admit({ kind: 'copilot-turn', title: 'Stopped turn', ownerState: 'verified', ownerPrincipal: SCENARIO_OWNER }),
        lost: admit({ kind: 'copilot-task', title: 'Lost task', ownerState: 'unverified' }),
    };
    registry.output(runs.robotTask, 'plain output\n');
    registry.output(runs.robotTask, '\u001b[32mcolour\u001b[0m and emoji 😀\n', 'assistant');
    registry.output(runs.robotTask, 'status line\n', 'status');
    registry.output(runs.robotTask, 'you> hello\n', 'user');
    registry.output(runs.robotTask, 'an error\n', 'error');
    registry.output(runs.robotTask, 'x'.repeat(70 * 1024));
    registry.status(runs.robotTask, 'running', 'Working on step 2');
    registry.status(runs.turn, 'reconnecting');
    registry.output(runs.finished, 'final words\n');
    registry.end(runs.finished, 'finished', { reason: 'completed', code: 0 });
    registry.end(runs.failed, 'failed', { reason: 'ALA exited with 1: boom\nstack', code: 1 });
    registry.end(runs.stopped, 'stopped', { reason: 'stopped', signal: 'SIGTERM' });
    registry.end(runs.lost, 'lost', { reason: 'publisher disconnected' });
    return { registry, runs, outcomes };
}
