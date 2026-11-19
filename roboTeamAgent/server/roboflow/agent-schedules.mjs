import { invalid } from './graph.mjs';

// Caller identity comes from the verified MCP invocation, never from tool input.
export async function agentSchedule(service, principal, input) {
    if (!/^agent:[^/]+\/[^/]+$/.test(principal || '')) throw invalid('Verified agent identity required');
    if (typeof input.key !== 'string' || !input.key.trim() || input.key.length > 200) throw invalid('Use a stable schedule key');
    const current = service.schedules.listSync().find(job => job.agentPrincipal === principal && job.agentKey === input.key);
    const summary = job => job ? { id: job.id, enabled: job.enabled, revision: job.revision, nextRunAt: job.nextRunAt } : null;
    if (input.operation === 'get-schedule') return { schedule: summary(current) };
    if (input.operation === 'upsert-schedule') {
        const definition = { workflowTypeId: input.workflowTypeId, objective: input.objective, privateContext: input.privateContext ?? '',
            timing: input.timing, enabled: input.enabled, ...(input.folder !== undefined ? { folder: input.folder } : {}),
            ...(input.executionType !== undefined ? { executionType: input.executionType } : {}) };
        if (current && Object.entries(definition).every(([key, value]) => JSON.stringify(current[key]) === JSON.stringify(value))) {
            return { schedule: summary(current) };
        }
        const saved = await service.schedules.save({ ...definition, revision: current?.revision }, principal, current?.id,
            { agentPrincipal: principal, agentKey: input.key });
        return { schedule: summary(saved) };
    }
    if (!current) throw Object.assign(invalid('Cron job not found'), { statusCode: 404 });
    if (input.operation === 'set-schedule-enabled') {
        if (typeof input.enabled !== 'boolean') throw invalid('enabled must be boolean');
        if (current.enabled === input.enabled) return { schedule: summary(current) };
        const saved = await service.schedules.save({ enabled: input.enabled, revision: current.revision }, principal, current.id);
        return { schedule: summary(saved) };
    }
    if (input.operation === 'delete-schedule') return { deleted: await service.deleteSchedule(current.id) };
    if (input.operation === 'run-schedule') {
        const result = await service.runScheduleNow(current.id, current.revision, principal);
        return { flowId: result.flow?.id, schedule: summary(result.schedule) };
    }
    throw invalid('Unknown schedule operation');
}
