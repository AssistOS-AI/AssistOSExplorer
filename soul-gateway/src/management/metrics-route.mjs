/**
 * Management metrics routes.
 *
 * GET /management/metrics/cost
 * GET /management/metrics/usage
 * GET /management/metrics/errors
 * GET /management/metrics/activity
 * GET /management/metrics/tokens
 *
 * (GET /management/metrics/system is registered in bootstrap.mjs)
 */

import { sendJson } from '../core/responses.mjs';
import { BadRequestError } from '../core/errors.mjs';
import { MetricsService } from '../observability/metrics-service.mjs';

/**
 * GET /management/metrics/cost
 */
export async function handleCostMetrics(ctx) {
  const { res, query, appCtx } = ctx;

  const { from, to } = requireDateRange(query);
  const groupBy = query.groupBy || 'day';

  const svc = new MetricsService(appCtx.pool);
  const data = await svc.getCostMetrics({ from, to, groupBy });
  sendJson(res, 200, { data });
}

/**
 * GET /management/metrics/usage
 */
export async function handleUsageMetrics(ctx) {
  const { res, query, appCtx } = ctx;

  const { from, to } = requireDateRange(query);
  const groupBy = query.groupBy || 'day';

  const svc = new MetricsService(appCtx.pool);
  const data = await svc.getUsageMetrics({ from, to, groupBy });
  sendJson(res, 200, { data });
}

/**
 * GET /management/metrics/errors
 */
export async function handleErrorMetrics(ctx) {
  const { res, query, appCtx } = ctx;

  const { from, to } = requireDateRange(query);

  const svc = new MetricsService(appCtx.pool);
  const data = await svc.getErrorMetrics({ from, to });
  sendJson(res, 200, { data });
}

/**
 * GET /management/metrics/activity
 */
export async function handleActivityMetrics(ctx) {
  const { res, query, appCtx } = ctx;

  const { from, to } = requireDateRange(query);
  const bucket = query.bucket || 'minute';

  const svc = new MetricsService(appCtx.pool);
  const data = await svc.getActivityMetrics({ from, to, bucket });
  sendJson(res, 200, { data });
}

/**
 * GET /management/metrics/tokens
 */
export async function handleTokenMetrics(ctx) {
  const { res, query, appCtx } = ctx;

  const { from, to } = requireDateRange(query);
  const groupBy = query.groupBy || 'day';

  const svc = new MetricsService(appCtx.pool);
  const data = await svc.getTokenMetrics({ from, to, groupBy });
  sendJson(res, 200, { data });
}

// ── helpers ──────────────────────────────────────────────────────────

function requireDateRange(query) {
  if (!query.from || !query.to) {
    throw new BadRequestError('Missing required query parameters: from, to');
  }
  return { from: query.from, to: query.to };
}
