import { CoordinatorAuthError, replayItems, verifyProviderTerminalLaunch } from '../coordinatorAuth.mjs';
import { createVerifiedServiceContext, isInternalId, WorkerStateError } from '../stateProtocol.mjs';
import { isProjectSelection } from '../terminalTargets.mjs';
import { launchHash } from './terminalProtocol.mjs';

// The robot-terminal execution path (M-8 SPEC "Launch", "Ends" and "Caps" rows; plan-review B-1, F-7; M-51, M-54, M-65). A robot terminal
// is a worker execution of kind `terminal`: admitted in S1 (schema 9), confined by the same launcher, ledger, HOME, masks and network
// as a workload, and ended through the same end path.
//
// launch({ fields, evidence }) -> Promise<Terminal>, or rejects with TerminalLaunchError(code). Order (zero spawns before step 6):
//   1. the launch evidence: verifyProviderTerminalLaunch over computeRch(fields) (direct non-guest administrator Router Request)  forbidden
//   2. its token ID consumed durably (S1 token_replay), so a replayed evidence is refused even after a restart                    forbidden
//   3. version 1 rules: `project.relativePath` must be ''; the selection is a canonical workspace-relative folder                  grant_refused
//      the target is a worker robot ID                                                                                           not_found
//      the sandbox and the PTY module are available                                                                              sandbox_unavailable
//   4. store.admitTerminal: ready robot, caps (4 per robot, 16 per worker) in one transaction       not_found | robot_not_ready | terminal_limit
//   5. factory.openTerminal: HOME, and the project folder through resolveExecutionGrants (M-63)      grant_refused | robot_not_ready
//   6. the PTY pair (node-pty open), then the anchor, runtime directory, execution network and the terminal process tree, with the slave
//      in stdio 0-2 (sandboxLauncher role `terminal`, ROLE_FD_ALLOW.terminal = [0, 1, 2])                                         sandbox_unavailable
//   7. queued -> running, then the worker's slave copy is closed; only then does the caller send `launched`
// A failure after step 4 ends the admission through beginAttemptEnd (expectedState `queued`) and the ledger, so nothing is left behind.
//
// Terminal { robotId, executionId, onData(fn), write(buf, cb), resize(cols, rows), pause(), resume(), exited (Promise<{exitCode, signal}>),
//            revoked (Promise<reason>), end(cause, exitCode?) -> Promise<{ verified }> }
// end: the master is closed first (the shell's session gets SIGHUP), then the section 5.5 end path; `verified` is false when a blocker was
// quarantined (termination unverified: the robot is nonready with resource_quarantined until an administrator clears it). The recorded
// result never holds terminal bytes (M-51 add. 1): outputText '' and data { cause, exitCode? } only.

export const LAUNCH_FAILURE_CODES = Object.freeze(['forbidden', 'not_found', 'robot_not_ready', 'terminal_limit', 'grant_refused', 'sandbox_unavailable']);
export const DEFAULT_TERMINAL_LIMITS = Object.freeze({ maxPerRobot: 4, maxTotal: 16 });
const CLASSIFICATION = Object.freeze({ exit: 'completed', shutdown: 'cancelled' });

export class TerminalLaunchError extends Error {
    constructor(code) {
        super(`terminal launch: ${code}`);
        this.code = LAUNCH_FAILURE_CODES.includes(code) ? code : 'sandbox_unavailable';
    }
}

function stateCode(error) {
    if (!(error instanceof WorkerStateError)) return 'sandbox_unavailable';
    if (error.code === 'not_found') return 'not_found';
    if (error.code === 'capacity_exceeded') return 'terminal_limit';
    if (['runtime_unavailable', 'robot_busy', 'resource_quarantined', 'recovery_pending', 'stale_generation'].includes(error.code)) return 'robot_not_ready';
    return 'sandbox_unavailable';
}

// ExecutionSetupError carries its bounded code as `reason`.
function setupCode(error) {
    const code = String(error?.reason ?? error?.code ?? '');
    if (code.startsWith('grant_') || code === 'runtime_sources_unavailable') return 'grant_refused';
    if (code === 'robot_storage_unavailable') return 'robot_not_ready';
    return 'sandbox_unavailable';
}

export function createTerminalExecutions({ store, verifier, workspaceId, path, factory, ptyHost, limits = DEFAULT_TERMINAL_LIMITS, log = () => {} }) {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('The terminals path is required');
    const maxPerRobot = limits.maxPerRobot ?? DEFAULT_TERMINAL_LIMITS.maxPerRobot;
    const maxTotal = limits.maxTotal ?? DEFAULT_TERMINAL_LIMITS.maxTotal;
    const context = createVerifiedServiceContext({
        workspaceId, scope: 'worker:terminals', ownerId: 'worker:terminals', robotOwnerId: 'worker:terminals', operations: ['adapter_complete']
    });

    // Steps 1-2: the evidence of one launch frame (a retry of the same operation re-mints it, and it is checked again).
    function authorize(fields, evidence) {
        let facts;
        try {
            facts = verifyProviderTerminalLaunch(verifier, evidence, { path, expectedRch: launchHash(fields) });
        } catch (error) {
            log('terminal_refusal', { stage: 'evidence', reason: error instanceof CoordinatorAuthError ? error.reason : 'invalid' });
            throw new TerminalLaunchError('forbidden');
        }
        try {
            store.consumeTokenIds({ items: replayItems([facts]) });
        } catch (error) {
            log('terminal_refusal', { stage: 'evidence', reason: error?.reason ?? error?.code ?? 'replay' });
            throw new TerminalLaunchError('forbidden');
        }
        return facts;
    }

    function failAdmission(admitted, code) {
        try {
            store.beginAttemptEnd(context, {
                executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued',
                outcome: { classification: 'failed', outputText: '', data: { cause: 'launch_failed', code } }
            });
        } catch { /* already ended or the generation rolled: recovery settles it */ }
    }

    async function launch({ fields, evidence }) {
        const facts = authorize(fields, evidence);
        const project = fields.project;
        if (project !== null && (project.relativePath !== '' || !isProjectSelection(project.selection))) {
            log('terminal_refusal', { stage: 'project', reason: project.relativePath !== '' ? 'relative_path' : 'selection' });
            throw new TerminalLaunchError('grant_refused');
        }
        if (!isInternalId(fields.targetId)) throw new TerminalLaunchError('not_found');
        if (!factory || typeof factory.openTerminal !== 'function' || !ptyHost || ptyHost.available().ok !== true) throw new TerminalLaunchError('sandbox_unavailable');

        let admitted;
        try {
            admitted = store.admitTerminal({ robotId: fields.targetId, ownerId: facts.userKey, maxPerRobot, maxTotal });
        } catch (error) {
            const code = stateCode(error);
            log('terminal_refusal', { stage: 'admission', code, reason: error?.code ?? 'error' });
            throw new TerminalLaunchError(code);
        }
        const item = { robotId: admitted.robotId, executionId: admitted.executionId, attemptId: admitted.attemptId };

        let execution;
        try {
            execution = await factory.openTerminal({ item, project: project === null ? null : { selection: project.selection }, context });
        } catch (error) {
            const code = setupCode(error);
            log('terminal_refusal', { stage: 'grants', code, reason: String(error?.reason ?? error?.code ?? 'error').slice(0, 48), executionId: item.executionId });
            failAdmission(admitted, code);
            throw new TerminalLaunchError(code);
        }

        let pty = null;
        let state = 'queued';
        const abandon = async (code) => {
            try { pty?.close(); } catch { /* closed */ }
            try {
                await execution.end({ classification: 'failed', outputText: '', data: { cause: 'launch_failed', code }, expectedState: state });
            } catch { /* recovery settles it */ }
        };
        try {
            pty = ptyHost.open({ cols: fields.cols, rows: fields.rows });
            await execution.start({ slave: pty.slaveFd });
            store.transitionAttempt({ executionId: item.executionId, attemptId: item.attemptId, expectedState: 'queued', nextState: 'running' });
            state = 'running';
        } catch (error) {
            log('terminal_refusal', { stage: 'launch', code: 'sandbox_unavailable', reason: String(error?.code ?? error?.name ?? 'error').slice(0, 48), executionId: item.executionId });
            await abandon('sandbox_unavailable');
            throw new TerminalLaunchError('sandbox_unavailable');
        } finally {
            pty?.destroySlave();
        }
        log('terminal_started', { robotId: item.robotId, executionId: item.executionId, project: project !== null, open: store.countOpenTerminals({ robotId: item.robotId }) });

        let ending = null;
        return {
            robotId: item.robotId,
            executionId: item.executionId,
            onData: (fn) => pty.onData(fn),
            write: (buffer, callback) => pty.write(buffer, callback),
            resize: (cols, rows) => pty.resize(cols, rows),
            pause: () => pty.pause(),
            resume: () => pty.resume(),
            exited: execution.exited,
            revoked: execution.revoked,
            lost: execution.lost,
            end(cause, exitCode) {
                ending ??= (async () => {
                    // SIGHUP first: an interactive bash ignores SIGTERM, so the end path would otherwise wait its whole grace period.
                    pty.close();
                    const data = { cause, ...(Number.isInteger(exitCode) ? { exitCode } : {}) };
                    let verified = false;
                    try {
                        const ended = await execution.end({ classification: CLASSIFICATION[cause] ?? 'interrupted', outputText: '', data, expectedState: 'running' });
                        verified = !(ended?.releaseLog ?? []).some((entry) => entry.outcome === 'quarantined');
                    } catch {
                        verified = false;
                    }
                    log(verified ? 'terminal_ended' : 'terminal_termination_unverified', {
                        robotId: item.robotId, executionId: item.executionId, cause, ...(Number.isInteger(exitCode) ? { exitCode } : {}),
                        inputBytes: pty.bytes.input, outputBytes: pty.bytes.output
                    });
                    return { verified };
                })();
                return ending;
            }
        };
    }

    return Object.freeze({ authorize, launch, limits: Object.freeze({ maxPerRobot, maxTotal }) });
}
