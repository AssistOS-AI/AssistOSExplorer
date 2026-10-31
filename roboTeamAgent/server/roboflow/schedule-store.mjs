import { GUI_EXECUTION_TYPES, guiUnavailableWithWorkerError } from '../gui-unavailable.mjs';
import crypto from 'node:crypto';
import { invalid, textField, resolveWorkflowObjective } from './graph.mjs';
import { normalizeTiming, nextRun } from './schedule-timing.mjs';

const conflict = message => Object.assign(invalid(message), { statusCode: 409 });
export class ScheduleStore {
    constructor({ database, registry, resolveCwd, defaultFolder, now = Date.now, refuseGui = false }) {
        Object.assign(this, { database, registry, resolveCwd, defaultFolder, now, refuseGui });
    }
    getSync(id) {
        const row = this.database.db.prepare('SELECT record FROM workflow_schedules WHERE id=?').get(id);
        return row ? JSON.parse(row.record) : null;
    }
    listSync() { return this.database.db.prepare('SELECT record FROM workflow_schedules ORDER BY rowid DESC').all().map(row => JSON.parse(row.record)); }
    saveSync(record) {
        this.database.db.prepare('INSERT INTO workflow_schedules VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record.id, JSON.stringify(record));
        return record;
    }
    assertWorkflowRemovable(id) {
        if (this.listSync().some(job => job.workflowTypeId === id)) throw conflict('Delete this workflow’s Cron jobs before deleting the workflow');
    }
    // ownerPrincipal is the signed principal of this saver (null for an
    // unsigned saver): whoever last defined what runs owns its launches.
    async save(input, createdBy, id, { ownerPrincipal = null } = {}) {
        const previous = id ? this.getSync(id) : null;
        if (id && !previous) throw Object.assign(invalid('Cron job not found'), { statusCode: 404 });
        if (id && input.revision !== previous.revision) throw conflict('Cron job changed; reload before saving');
        const value = { ...previous, ...input };
        const objective = textField(value.objective, 'objective', 32768);
        const workflowTypeId = textField(value.workflowTypeId, 'workflowTypeId', 80, true);
        const timing = normalizeTiming(value.timing);
        if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw invalid('enabled must be boolean');
        const selectedWorkflow = this.registry.getSync(workflowTypeId);
        if (!selectedWorkflow) throw invalid('Choose an existing workflow type');
        resolveWorkflowObjective(selectedWorkflow, objective);
        if (selectedWorkflow.kind === 'default' ? !['terminal', 'browser', 'desktop'].includes(value.executionType) : input.executionType !== undefined) throw invalid('Execution mode is required only for Standard development');
        // With the worker a Browser or Desktop schedule is refused when it is saved enabled (decision M-67), before anything is stored. A
        // schedule saved disabled is accepted, so a leftover one from before the worker can still be paused with its definition kept.
        if (this.refuseGui && value.enabled !== false && selectedWorkflow.kind === 'default' && GUI_EXECUTION_TYPES.includes(value.executionType)) throw guiUnavailableWithWorkerError();
        const selectedFolder = textField(value.folder, 'folder', 4096);
        const folder = selectedFolder ? await this.resolveCwd(selectedFolder) : await this.defaultFolder();
        return this.database.transaction(() => {
            const current = id ? this.getSync(id) : null;
            if (id && (!current || current.revision !== input.revision)) throw conflict('Cron job changed; reload before saving');
            const graph = this.registry.getSync(workflowTypeId);
            if (!graph) throw invalid('Choose an existing workflow type');
            resolveWorkflowObjective(graph, objective);
            if (graph.kind === 'default' ? !['terminal', 'browser', 'desktop'].includes(value.executionType) : input.executionType !== undefined) throw invalid('Execution mode is required only for Standard development');
            const timestamp = this.now(), now = new Date(timestamp).toISOString(), enabled = value.enabled ?? true;
            const configChanged = !current || current.enabled !== enabled || JSON.stringify(current.timing) !== JSON.stringify(timing);
            const revision = (current?.revision || 0) + 1;
            // bindingRevision names the worker binding of what runs (cron_<id>.r<n>): every save
            // sets it to the new revision; run-now bumps only `revision` and never changes it.
            const record = { ...current, id: id || `cron_${crypto.randomBytes(12).toString('hex')}`, revision, bindingRevision: revision,
                objective, folder, workflowTypeId: graph.id, ...(graph.kind === 'default' ? { executionType: value.executionType } : {}), timing, enabled,
                createdBy: current?.createdBy || createdBy, updatedBy: createdBy, ownerPrincipal: ownerPrincipal || null,
                createdAt: current?.createdAt || now, updatedAt: now,
                nextRunAt: enabled ? (configChanged ? new Date(nextRun(timing, timestamp)).toISOString() : current.nextRunAt) : null,
                lastFlowId: current?.lastFlowId || null, lastAttemptAt: current?.lastAttemptAt || null, lastOutcome: current?.lastOutcome || null,
                lastError: current?.lastError || null, pendingLaunch: null };
            delete record.name;
            if (graph.kind !== 'default') delete record.executionType;
            return this.saveSync(record);
        });
    }
    remove(id) {
        return this.database.db.prepare('DELETE FROM workflow_schedules WHERE id=?').run(id).changes > 0;
    }
}
