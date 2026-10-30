import path from 'node:path';
import { LiveSessionsFullError } from './registry.mjs';

// In-process Live Session source: robot tasks and RoboFlow workflow phases
// that main.mjs runs. Everything a row needs (owner, workflow phase, robot) is
// captured when the runtime admits the task, because RoboFlow forgets its
// binding as soon as it handles the terminal event.
const OWNER_PRINCIPAL = /^user:.+/u;
const TYPE_LABELS = Object.freeze({ simple: 'CLI', browser: 'Browser', desktop: 'Desktop' });

function liveFailure(outcome, message) {
    return Object.assign(new Error(message), { liveOutcome: outcome });
}

function delivery(result) {
    const value = result?.delivery;
    if (value === 'delivered' || value === 'queued') return value;
    throw liveFailure('unknown', 'delivery was not confirmed');
}

// Runs observers in order. The first (RoboFlow) keeps its existing error
// reporting; each later observer is isolated so it can never disturb RoboFlow
// or another observer.
export function composeTaskObservers(primary, secondaries = [], log = (line) => console.error(line)) {
    return (event) => {
        let failure = null;
        try { primary(event); } catch (error) { failure = error; }
        for (const observer of secondaries) {
            try { observer(event); } catch (error) { log(`[live-sessions] task observer failed: ${error?.message || error}`); }
        }
        if (failure) throw failure;
    };
}

export class RuntimeLiveSource {
    constructor({ registry, runtimeManager, robotStore, roboflow = null, workspaceRoot, readTranscript = null, log = (line) => console.warn(line) }) {
        Object.assign(this, { registry, runtimeManager, robotStore, roboflow, log });
        this.workspaceRoot = path.resolve(workspaceRoot || runtimeManager?.workspaceRoot || '/');
        this.readTranscript = typeof readTranscript === 'function' ? readTranscript : null;
        this.runs = new Map();
    }

    onRuntimeTaskEvent(event) {
        if (!event || typeof event.taskId !== 'string') return;
        if (event.kind === 'admitted') return this._admit(event);
        const tracked = this.runs.get(event.taskId);
        if (!tracked) return;
        if (event.kind === 'progress') {
            this.registry.output(tracked.runId, String(event.chunk ?? ''), event.outputKind === 'assistant' ? 'assistant' : 'output');
        } else if (event.kind === 'state') {
            // Queued and starting work is waiting; it runs once the runtime says so.
            if (event.state === 'running') this.registry.status(tracked.runId, 'running');
        } else if (event.kind === 'terminal') {
            this.runs.delete(event.taskId);
            const failed = event.state === 'failed' || event.forcedFailure === true || (event.state === 'completed' && event.error);
            const status = event.state === 'paused' && !failed ? 'stopped' : failed ? 'failed' : 'finished';
            const reason = status === 'finished' ? 'completed' : status === 'stopped' ? 'stopped' : String(event.error || 'failed');
            this.registry.end(tracked.runId, status, { reason });
        }
    }

    _cwdDisplay(cwd) {
        if (typeof cwd !== 'string' || !cwd) return '';
        const relative = path.relative(this.workspaceRoot, cwd);
        if (!relative) return '.';
        return relative.startsWith('..') || path.isAbsolute(relative) ? path.basename(cwd) : relative;
    }

    _admit(event) {
        const ownerPrincipal = typeof event.ownerPrincipal === 'string' && OWNER_PRINCIPAL.test(event.ownerPrincipal) ? event.ownerPrincipal : null;
        const phase = typeof event.workflowRunId === 'string' && event.workflowRunId && typeof event.workflowInstanceId === 'string' && event.workflowInstanceId
            ? { flowId: event.workflowRunId, instanceId: event.workflowInstanceId } : null;
        const tracked = { taskId: event.taskId, robotId: event.robotId, type: event.type, phase, runId: null };
        const robotName = String(event.robotName || event.robotId || 'robot');
        let title;
        let detail;
        if (phase) {
            const workflowName = this.roboflow?.store?.getSync?.(phase.flowId)?.workflowName;
            title = `Workflow phase · ${workflowName || 'workflow'}`;
            detail = `Robot ${robotName} · Stop pauses the whole workflow`;
        } else {
            title = `Robot task · ${robotName}`;
            detail = `${TYPE_LABELS[event.type] || 'Robot'} task`;
        }
        try {
            tracked.runId = this.registry.admit({
                kind: phase ? 'workflow-phase' : 'robot-task',
                title, detail, cwdDisplay: this._cwdDisplay(event.cwd), access: 'rw',
                ownerState: ownerPrincipal ? 'verified' : 'system', ownerPrincipal, status: 'waiting',
                controls: { message: (text, options) => this._message(tracked, text, options), stop: (options) => this._stop(tracked, options) },
                transcript: phase || this.readTranscript ? () => this._transcript(tracked) : null,
            }).id;
        } catch (error) {
            if (error instanceof LiveSessionsFullError) this.log(`[live-sessions] task ${event.taskId} is not listed: registry is full`);
            else this.log(`[live-sessions] task ${event.taskId} is not listed: ${error?.message || error}`);
            return;
        }
        this.runs.set(event.taskId, tracked);
    }

    async _robot(tracked) {
        const robot = await this.robotStore.get(tracked.robotId);
        if (!robot) throw Object.assign(liveFailure('run_ended', 'Robot is unavailable'), { statusCode: 409 });
        return robot;
    }

    // `options.user.grant` is the requesting user's own grant (worker mode, decision M-12 (b)); absent otherwise.
    async _message(tracked, text, options = undefined) {
        if (tracked.phase) {
            try {
                return delivery(await this.roboflow.messageInstance(tracked.phase.flowId, tracked.phase.instanceId, text, options?.user ?? null));
            } catch (error) {
                if (!error?.liveOutcome && Number.isInteger(error?.statusCode)) error.liveOutcome = error.statusCode === 404 ? 'run_ended' : 'rejected';
                throw error;
            }
        }
        return delivery(await this.runtimeManager.sendTaskMessage(await this._robot(tracked), tracked.taskId, text, options?.user?.grant ? { ownerGrant: options.user.grant } : undefined));
    }

    async _stop(tracked, options = undefined) {
        // A workflow phase stop pauses the whole workflow, which stays resumable.
        if (tracked.phase) return void await this.roboflow.pauseInstance(tracked.phase.flowId, tracked.phase.instanceId, options?.user ?? null);
        this.runtimeManager.stopTask(await this._robot(tracked), tracked.type, tracked.taskId,
            options?.user ? { userInitiated: true, ...(options.user.grant ? { ownerGrant: options.user.grant } : {}) } : undefined);
    }

    // Transcript text from server-bound metadata: the phase's execution log, or
    // the task's own ALA turn once its turn started. Never container logs.
    async _transcript(tracked) {
        if (tracked.phase) return (await this.roboflow.getInvocationLog(tracked.phase.flowId, tracked.phase.instanceId)) || null;
        const ref = this.runtimeManager.taskTranscriptRef?.(tracked.robotId, tracked.taskId);
        if (!ref || !this.readTranscript) return null;
        return this.readTranscript(ref);
    }
}
