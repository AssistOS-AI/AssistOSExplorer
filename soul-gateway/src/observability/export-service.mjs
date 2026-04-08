import * as auditDao from '../db/dao/audit-logs-dao.mjs';

const CSV_COLUMNS = [
    'log_id',
    'request_id',
    'soul_id',
    'agent_name',
    'requested_model',
    'status',
    'http_status',
    'error_type',
    'latency_ms',
    'ttfb_ms',
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'total_cost_usd',
    'cache_hit',
    'blocked',
    'streaming',
    'started_at',
    'completed_at',
];

/**
 * ExportService — streaming bulk export of audit logs.
 */
export class ExportService {
    constructor(pool, batchSize = 500) {
        this.pool = pool;
        this.batchSize = batchSize;
    }

    /**
     * Stream CSV rows to the response.
     */
    async exportCsv(res, { from, to, soulId, model }) {
        res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition':
                'attachment; filename="soul-gateway-logs.csv"',
            'Transfer-Encoding': 'chunked',
        });

        // Header row
        res.write(CSV_COLUMNS.join(',') + '\n');

        let offset = 0;
        while (true) {
            const { rows } = await auditDao.query(this.pool, {
                from,
                to,
                soul_id: soulId,
                model,
                limit: this.batchSize,
                offset,
                sort: 'started_at',
                order: 'asc',
            });

            for (const row of rows) {
                res.write(
                    CSV_COLUMNS.map((col) => escapeCsvField(row[col])).join(
                        ','
                    ) + '\n'
                );
            }

            if (rows.length < this.batchSize) break;
            offset += this.batchSize;
        }

        res.end();
    }

    /**
     * Stream JSON array to the response.
     */
    async exportJson(res, { from, to, soulId, model }) {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Disposition':
                'attachment; filename="soul-gateway-logs.json"',
            'Transfer-Encoding': 'chunked',
        });

        res.write('[\n');

        let offset = 0;
        let first = true;
        while (true) {
            const { rows } = await auditDao.query(this.pool, {
                from,
                to,
                soul_id: soulId,
                model,
                limit: this.batchSize,
                offset,
                sort: 'started_at',
                order: 'asc',
            });

            for (const row of rows) {
                if (!first) res.write(',\n');
                res.write(JSON.stringify(row));
                first = false;
            }

            if (rows.length < this.batchSize) break;
            offset += this.batchSize;
        }

        res.write('\n]');
        res.end();
    }
}

function escapeCsvField(val) {
    if (val == null) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}
