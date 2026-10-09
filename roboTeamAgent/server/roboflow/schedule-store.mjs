import crypto from 'node:crypto';
import { invalid, textField, resolveWorkflowObjective } from './graph.mjs';
import { normalizeTiming, nextRun } from './schedule-timing.mjs';

const conflict = message => Object.assign(invalid(message), { statusCode: 409 });
export class ScheduleStore {
    constructor({ database, registry, resolveCwd, defaultFolder, now = Date.now }) {
        Object.assign(this, { database, registry, resolveCwd, defaultFolder, now });
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
    async save(input, createdBy, id) {
        const previous = id ? this.getSync(id) : null;
        if (id && !previous) throw Object.assign(invalid('Cron job not found'), { statusCode: 404 });
        if (id && input.revision !== previous.revision) throw conflict('Cron job changed; reload before saving');
        const value = { ...previous, ...input };
        const name = textField(value.name, 'name', 120, true);
        const objective = textField(value.objective, 'objective', 32768);
        const workflowTypeId = textField(value.workflowTypeId, 'workflowTypeId', 80, true);
        const timing = normalizeTiming(value.timing);
        if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw invalid('enabled must be boolean');
        const selectedWorkflow = this.registry.getSync(workflowTypeId);
        if (!selectedWorkflow) throw invalid('Choose an existing workflow type');
        resolveWorkflowObjective(selectedWorkflow, objective);
        if (selectedWorkflow.kind === 'default' ? !['terminal', 'browser', 'desktop'].includes(value.executionType) : input.executionType !== undefined) throw invalid('Execution mode is required only for Standard development');
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
            const record = { ...current, id: id || `cron_${crypto.randomBytes(12).toString('hex')}`, revision: (current?.revision || 0) + 1,
                name, objective, folder, workflowTypeId: graph.id, ...(graph.kind === 'default' ? { executionType: value.executionType } : {}), timing, enabled,
                createdBy: current?.createdBy || createdBy, updatedBy: createdBy, createdAt: current?.createdAt || now, updatedAt: now,
                nextRunAt: enabled ? (configChanged ? new Date(nextRun(timing, timestamp)).toISOString() : current.nextRunAt) : null,
                lastFlowId: current?.lastFlowId || null, lastAttemptAt: current?.lastAttemptAt || null, lastOutcome: current?.lastOutcome || null,
                lastError: current?.lastError || null, pendingLaunch: null };
            if (graph.kind !== 'default') delete record.executionType;
            return this.saveSync(record);
        });
    }
    remove(id) {
        return this.database.db.prepare('DELETE FROM workflow_schedules WHERE id=?').run(id).changes > 0;
    }
}
