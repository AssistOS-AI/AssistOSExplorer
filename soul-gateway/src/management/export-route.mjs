/**
 * Management export routes.
 *
 * GET /management/export/logs.csv
 * GET /management/export/logs.json
 */

import { ExportService } from '../observability/export-service.mjs';

/**
 * GET /management/export/logs.csv
 * Stream CSV export of filtered audit logs.
 */
export async function handleExportCsv(ctx) {
    const { res, query, appCtx } = ctx;

    const svc = new ExportService(appCtx.pool);
    await svc.exportCsv(res, {
        from: query.from || null,
        to: query.to || null,
        soulId: query.soul_id || null,
        model: query.model || null,
    });
}

/**
 * GET /management/export/logs.json
 * Stream JSON export of filtered audit logs.
 */
export async function handleExportJson(ctx) {
    const { res, query, appCtx } = ctx;

    const svc = new ExportService(appCtx.pool);
    await svc.exportJson(res, {
        from: query.from || null,
        to: query.to || null,
        soulId: query.soul_id || null,
        model: query.model || null,
    });
}
