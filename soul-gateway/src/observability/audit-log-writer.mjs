import * as auditDao from '../db/dao/audit-logs-dao.mjs';

/**
 * AuditLogWriter — durable request logging.
 *
 * Every request writes two rows:
 *  1. insertStart() at the beginning (status='in_progress')
 *  2. finalize() at the end (status='succeeded'|'failed'|'aborted')
 *
 * After finalize, emits the completed log entry to BroadcastHub.
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

    async start(entry) {
        try {
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
}
