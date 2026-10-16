/**
 * Management export routes.
 *
 * GET /management/export/logs.csv
 * GET /management/export/logs.json
 */

/**
 * GET /management/export/logs.csv
 * Stream CSV export of filtered audit logs.
 */
export async function handleExportCsv(ctx) {
    const { res, query, appCtx } = ctx;

    await appCtx.services.exportService.exportCsv(res, {
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

    await appCtx.services.exportService.exportJson(res, {
        from: query.from || null,
        to: query.to || null,
        soulId: query.soul_id || null,
        model: query.model || null,
    });
}
