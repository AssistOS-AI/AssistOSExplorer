import * as auditDao from '../db/dao/audit-logs-dao.mjs';
import * as keysDao from '../db/dao/api-keys-dao.mjs';

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
                await this.publishLiveRow(row);
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
                await this.publishLiveRow(row);
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

    async publishLiveRow(row) {
        const subscriberCount = Number(this.broadcastHub?.subscriberCount ?? 1);
        if (subscriberCount <= 0) {
            this.broadcastHub.publish(row);
            return;
        }
        this.broadcastHub.publish(await this.withSafeKeyDisplay(row));
    }

    async withSafeKeyDisplay(row) {
        try {
            const display = await keysDao.findSafeDisplayById(
                this.pool,
                row.api_key_id
            );
            return { ...row, ...display };
        } catch (err) {
            this.log.warn?.('audit live key display lookup failed', {
                logId: row.log_id,
                apiKeyId: row.api_key_id,
                error: err.message,
            });
            const fallback = row.api_key_id ? 'Missing key' : 'Unknown key';
            return {
                ...row,
                key_label: row.key_label || fallback,
                key_hint: row.key_hint || '',
                key_status: row.key_status || 'unknown',
            };
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
