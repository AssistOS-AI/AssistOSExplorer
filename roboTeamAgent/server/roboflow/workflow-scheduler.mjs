import crypto from 'node:crypto';
import { nextRun } from './schedule-timing.mjs';
import { invalid } from './graph.mjs';

const heldStates = new Set(['pending', 'running', 'paused']);
export class WorkflowScheduler {
    constructor({ schedules, flows, startFlow, now = Date.now, pollMs = 1000, onError = error => console.error(`[cron-jobs] ${error.message}`) }) {
        Object.assign(this, { schedules, flows, startFlow, now, pollMs, onError });
        this.closed = true;
        this.manualLaunches = new Set();
    }
    initialize() {
        const now = this.now();
        this.schedules.database.transaction(() => {
            for (const job of this.schedules.listSync()) {
                if (job.pendingLaunch) { job.pendingLaunch = null; job.lastOutcome = 'failed'; job.lastError = 'Launch interrupted by service restart; occurrence will not be retried'; }
                if (job.enabled && job.nextRunAt && Date.parse(job.nextRunAt) <= now) job.nextRunAt = new Date(nextRun(job.timing, now, Date.parse(job.nextRunAt))).toISOString();
                this.schedules.saveSync(job);
            }
        });
    }
    start() {
        if (!this.closed) return;
        this.closed = false;
        this.timer = setInterval(() => { void this.tick().catch(this.onError); }, this.pollMs);
        this.timer.unref?.();
    }
    async tick() {
        if (this.closed) return;
        if (this.pending) return this.pending;
        this.pending = this._tick();
        try { await this.pending; } finally { this.pending = null; }
    }
    async runNow(id, revision, createdBy) {
        if (this.closed) throw Object.assign(invalid('Cron job scheduler is not running'), { statusCode: 503 });
        if (!Number.isSafeInteger(revision)) throw invalid('A current Cron job revision is required');
        const job = this.schedules.database.transaction(() => {
            const current = this.schedules.getSync(id);
            if (!current) throw Object.assign(invalid('Cron job not found'), { statusCode: 404 });
            if (current.revision !== revision) throw Object.assign(invalid('Cron job changed; reload before running'), { statusCode: 409 });
            const previous = current.lastFlowId && this.flows.getSync(current.lastFlowId);
            if (current.pendingLaunch || (previous && heldStates.has(previous.status))) throw Object.assign(invalid('This Cron job already has a running or paused workflow'), { statusCode: 409 });
            const timestamp = this.now(), now = new Date(timestamp).toISOString();
            current.revision++; current.updatedBy = createdBy; current.updatedAt = now;
            current.nextRunAt = current.enabled ? new Date(nextRun(current.timing, timestamp)).toISOString() : null;
            current.lastAttemptAt = now; current.lastError = null;
            current.pendingLaunch = { token: crypto.randomUUID(), scheduledAt: now };
            this.schedules.saveSync(current);
            return structuredClone(current);
        });
        const launch = this._launch(job, { manual: true, createdBy });
        this.manualLaunches.add(launch);
        try { return await launch; } finally { this.manualLaunches.delete(launch); }
    }
    async _tick() {
        const now = this.now();
        const claimed = this.schedules.database.transaction(() => {
            const result = [];
            for (const job of this.schedules.listSync()) {
                if (!job.enabled || !job.nextRunAt || Date.parse(job.nextRunAt) > now) continue;
                const scheduledAt = job.nextRunAt;
                job.nextRunAt = new Date(nextRun(job.timing, now, Date.parse(scheduledAt))).toISOString();
                job.lastAttemptAt = new Date(now).toISOString();
                const previous = job.lastFlowId && this.flows.getSync(job.lastFlowId);
                if (job.pendingLaunch || (previous && heldStates.has(previous.status))) {
                    job.lastOutcome = 'skipped'; job.lastError = 'Previous scheduled workflow is still running or paused';
                } else {
                    job.pendingLaunch = { token: crypto.randomUUID(), scheduledAt };
                    job.lastError = null; result.push(structuredClone(job));
                }
                this.schedules.saveSync(job);
            }
            return result;
        });
        await Promise.all(claimed.map(job => this._launch(job)));
    }
    async _launch(job, { manual = false, createdBy = job.createdBy } = {}) {
        try {
            if (this.closed) throw new Error('Cron job scheduler stopped before launch');
            return await this.startFlow({ workflowTypeId: job.workflowTypeId, objective: job.objective, folder: job.folder, executionType: job.executionType, createdBy }, {
                scheduleId: job.id, scheduledAt: job.pendingLaunch.scheduledAt,
                onCreated: flow => {
                    const current = this.schedules.getSync(job.id);
                    if (this.closed || !current || (!manual && !current.enabled) || current.pendingLaunch?.token !== job.pendingLaunch.token) throw new Error('Cron job changed before launch');
                    current.pendingLaunch = null; current.lastFlowId = flow.id; current.lastOutcome = 'started'; current.lastError = null;
                    this.schedules.saveSync(current);
                },
            });
        } catch (error) {
            this.schedules.database.transaction(() => {
                const current = this.schedules.getSync(job.id);
                if (current?.pendingLaunch?.token !== job.pendingLaunch.token) return;
                current.pendingLaunch = null; current.lastOutcome = 'failed'; current.lastError = error.message;
                this.schedules.saveSync(current);
            });
            if (manual) throw error;
        }
    }
    async close() { this.closed = true; clearInterval(this.timer); await Promise.allSettled([this.pending, ...this.manualLaunches]); }
}
