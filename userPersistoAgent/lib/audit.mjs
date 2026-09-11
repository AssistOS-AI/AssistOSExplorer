import { randomUUID } from 'node:crypto';
import { getStore, flush } from './store.mjs';

export async function recordAudit({ actorId = 'system', action, target = '', result = 'ok', reason = '' }, { save = true } = {}) {
    if (!action) {
        throw new Error('audit action is required');
    }
    const store = await getStore();
    const event = await store.createAuditEvent({
        auditId: randomUUID(),
        actorId: String(actorId),
        action: String(action),
        target: String(target),
        result: String(result),
        reason: String(reason),
        timestamp: new Date().toISOString(),
    });
    if (save) await flush();
    return event;
}
