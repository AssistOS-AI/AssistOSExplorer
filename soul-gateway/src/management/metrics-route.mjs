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

/**
 * GET /management/metrics/cost
 */
export async function handleCostMetrics(ctx) {
    const { res, query, appCtx } = ctx;

    const { from, to } = requireDateRange(query);
    const groupBy = query.groupBy || 'day';

    const data = await appCtx.services.metricsService.getCostMetrics({ from, to, groupBy });
    sendJson(res, 200, { data });
}

/**
 * GET /management/metrics/usage
 */
export async function handleUsageMetrics(ctx) {
    const { res, query, appCtx } = ctx;

    const { from, to } = requireDateRange(query);
    const groupBy = query.groupBy || 'day';

    const data = await appCtx.services.metricsService.getUsageDashboardMetrics({
        from,
        to,
        groupBy,
        model: query.model || null,
        apiKeyId: query.api_key_id || null,
    });
    sendMetricPayload(res, data);
}

/**
 * GET /management/metrics/errors
 */
export async function handleErrorMetrics(ctx) {
    const { res, query, appCtx } = ctx;

    const { from, to } = requireDateRange(query);

    const data = await appCtx.services.metricsService.getErrorMetrics({ from, to });
    sendJson(res, 200, { data });
}

/**
 * GET /management/metrics/activity
 */
export async function handleActivityMetrics(ctx) {
    const { res, query, appCtx } = ctx;

    const { from, to } = requireDateRange(query);
    const bucket = query.bucket || 'minute';

    const data = await appCtx.services.metricsService.getActivityDashboardMetrics({
        from,
        to,
        bucket,
    });
    sendMetricPayload(res, data);
}

/**
 * GET /management/metrics/tokens
 */
export async function handleTokenMetrics(ctx) {
    const { res, query, appCtx } = ctx;

    const { from, to } = requireDateRange(query);
    const groupBy = query.groupBy || 'day';

    const data = await appCtx.services.metricsService.getTokenMetrics({ from, to, groupBy });
    sendJson(res, 200, { data });
}

// ── helpers ──────────────────────────────────────────────────────────

function requireDateRange(query) {
    if (!query.from) {
        throw new BadRequestError('Missing required query parameter: from');
    }
    return {
        from: query.from,
        to: query.to || new Date().toISOString(),
    };
}

function sendMetricPayload(res, data) {
    if (Array.isArray(data)) {
        sendJson(res, 200, { data });
        return;
    }
    if (data && typeof data === 'object' && Array.isArray(data.data)) {
        sendJson(res, 200, data);
        return;
    }
    sendJson(res, 200, { data });
}
