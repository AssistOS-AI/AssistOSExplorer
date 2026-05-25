import * as auditDao from '../db/dao/audit-logs-dao.mjs';

/**
 * AuditLogWriter — durable request logging.
 *
 * The route layer writes one completed row per request once the outcome
 * is known. After insert, emits the row to BroadcastHub.
 */
export class AuditLogWriter {
    constructor(appCtx) {
        this.pool = appCtx.pool;
        this.log = appCtx.log;
        this.broadcastHub = null; // set after BroadcastHub is initialized
    }

    setBroadcastHub(hub) {
        this.broadcastHub = hub;
    }

    async write(entry) {
        try {
            await this.ensurePartition(entry.startedAt);
            const row = await auditDao.insertCompleted(this.pool, entry);
            if (row && this.broadcastHub) {
                this.broadcastHub.publish(row);
            }
            return row;
        } catch (err) {
            this.log.error('audit write failed', {
                requestId: entry.requestId,
                error: err.message,
            });
            return null;
        }
    }

    // Legacy helpers kept for callers that still use the two-phase API.
    async start(entry) {
        try {
            await this.ensurePartition(entry.startedAt);
            return await auditDao.insertStart(this.pool, entry);
        } catch (err) {
            this.log.error('audit start write failed', {
                requestId: entry.requestId,
                error: err.message,
            });
            return null;
        }
    }

    async finalize(startedAt, logId, fields) {
        try {
            const row = await auditDao.finalize(this.pool, startedAt, logId, fields);
            if (row && this.broadcastHub) {
                this.broadcastHub.publish(row);
            }
            return row;
        } catch (err) {
            this.log.error('audit finalize write failed', {
                logId,
                error: err.message,
            });
            return null;
        }
    }

    async ensurePartition(value) {
        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) {
            return;
        }
        await auditDao.ensurePartition(this.pool, date);
    }
}
