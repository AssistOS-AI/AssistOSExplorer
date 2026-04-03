/**
 * Management export routes.
 *
 * GET /management/export/logs.csv
 * GET /management/export/logs.json
 *
 * Legacy compat:
 * GET /management/export/logs?format=csv|json
 */

import { sendJson } from '../core/responses.mjs';
import { BadRequestError } from '../core/errors.mjs';
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

/**
 * GET /management/export/logs?format=csv|json
 * Legacy compatibility: dispatch based on format query param.
 */
export async function handleExportLogs(ctx) {
  const { query } = ctx;
  const format = (query.format || 'json').toLowerCase();

  if (format === 'csv') {
    return handleExportCsv(ctx);
  }
  if (format === 'json') {
    return handleExportJson(ctx);
  }

  throw new BadRequestError(`Unsupported export format: ${format}. Use csv or json.`);
}
