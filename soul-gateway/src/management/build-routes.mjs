/**
 * Management route registration.
 *
 * Returns { httpRouter, wsRouter } where:
 *   - httpRouter has all HTTP management routes
 *   - wsRouter has WebSocket upgrade routes
 *
 * All management routes require verified Ploinky router admin identity.
 */

import { createRouter } from '../core/path-router.mjs';
import { requireAdmin } from '../runtime/security/dashboard-auth.mjs';

// Dashboard
import { handleDashboard, handleStatic } from './dashboard-route.mjs';

// Session
import { handleManagementMe } from './session-route.mjs';

// Keys
import {
    handleListKeys,
    handleProvisionUserKey,
    handleGetKey,
    handleUpdateKey,
    handleRevokeKey,
    handleResetDailyBudget,
    handleGetSpend,
} from './keys-route.mjs';

// Models
import {
    handleListModels,
    handleCreateModel,
    handleGetModel,
    handleUpdateModel,
    handleDeleteModel,
    handleEnableModel,
    handleDisableModel,
    handleListModelProviders,
    handleListProviderModels,
    handleListModelTags,
} from './models-route.mjs';

// Tiers
import {
    handleListTiers,
    handleCreateTier,
    handleGetTier,
    handleUpdateTier,
    handleDeleteTier,
    handleEnableTier,
    handleDisableTier,
} from './tiers-route.mjs';

// Providers
import {
    handleListTemplates,
    handleListProviders,
    handleCreateProvider,
    handleGetProvider,
    handleUpdateProvider,
    handleDeleteProvider,
    handleTestConnection,
    handleDiscoverModels,
    handleSyncModels,
    handleAuthStart,
    handleAuthCallback,
    handleAuthPending,
    handleListAccounts,
    handleDeleteAccount,
    handleResetAccountQuota,
    handleRescan as handleProviderRescan,
} from './providers-route.mjs';

// Middlewares
import {
    handleListMiddlewares,
    handleGetMiddleware,
    handleUpdateMiddleware,
    handleRescan as handleMiddlewareRescan,
    handleCreateAssignment,
    handleUpdateAssignment,
    handleDeleteAssignment,
    handleListModelMiddlewares,
    handleCreateModelMiddleware,
    handleUpdateModelMiddleware,
    handleDeleteModelMiddleware,
    handleReorderModelMiddlewares,
} from './middlewares-route.mjs';

// Blacklist
import {
    handleListRules,
    handleCreateRule,
    handleGetRule,
    handleUpdateRule,
    handleDeleteRule,
    handleEnableRule,
    handleDisableRule,
} from './blacklist-route.mjs';

// Cooldowns
import {
    handleListCooldowns,
    handleClearAll,
    handleClearModel,
} from './cooldowns-route.mjs';

// Logs
import {
    handleListLogs,
    handleListLogKeys,
    handleGetLog,
} from './logs-route.mjs';

// Metrics
import {
    handleCostMetrics,
    handleUsageMetrics,
    handleErrorMetrics,
    handleActivityMetrics,
    handleTokenMetrics,
} from './metrics-route.mjs';

// Export
import {
    handleExportCsv,
    handleExportJson,
} from './export-route.mjs';

// Sessions
import {
    handleListSessions,
    handleGetSession,
    handleGetSessionLogs,
    handleAgentsTree,
} from './sessions-route.mjs';

// Provider middlewares + backends.
import {
    handleListProviderMiddlewares,
    handleListBackends,
    handleListProviderMiddlewareBindings,
    handleCreateProviderMiddlewareBinding,
    handleUpdateProviderMiddlewareBinding,
    handleDeleteProviderMiddlewareBinding,
} from './provider-middlewares-route.mjs';

// SSE streaming
import {
    handleLogStreamSse,
    handleLogStreamSoul,
} from './log-stream-sse-route.mjs';

// WS streaming
import {
    handleLogStreamWs,
    handleLogStreamWsSoul,
} from './log-stream-ws-route.mjs';

/**
 * Build and return the management route registries with all routes registered.
 *
 * @param {object} appCtx
 * @returns {{ httpRouter: object, wsRouter: object }}
 */
export function buildManagementRouter(appCtx) {
    const httpRouter = createRouter();
    const wsRouter = createRouter();

    // ── Helper: wrap handler with Ploinky router admin auth ───────────
    function admin(handler) {
        return async (ctx) => {
            const managementAuth = await requireAdmin(
                ctx.req,
                appCtx.config.env,
                appCtx.routerAuth || appCtx
            );
            ctx.managementAuth = managementAuth;
            return handler(ctx);
        };
    }

    // ── Session ──────────────────────────────────────────────────────
    httpRouter.add('GET', '/management/me', admin(handleManagementMe));

    // ── Dashboard ────────────────────────────────────────────────────
    httpRouter.add('GET', '/management', admin(handleDashboard));
    httpRouter.add('GET', '/management/', admin(handleDashboard));
    httpRouter.add('GET', '/management/css/*', admin(handleStatic));
    httpRouter.add('GET', '/management/js/*', admin(handleStatic));

    // ── Keys ─────────────────────────────────────────────────────────
    httpRouter.add('GET', '/management/keys', admin(handleListKeys));
    httpRouter.add('POST', '/management/keys', admin(handleProvisionUserKey));
    httpRouter.add('GET', '/management/keys/:keyId', admin(handleGetKey));
    httpRouter.add('PATCH', '/management/keys/:keyId', admin(handleUpdateKey));
    httpRouter.add(
        'POST',
        '/management/keys/:keyId/revoke',
        admin(handleRevokeKey)
    );
    httpRouter.add(
        'POST',
        '/management/keys/:keyId/reset-daily-budget',
        admin(handleResetDailyBudget)
    );
    httpRouter.add(
        'GET',
        '/management/keys/:keyId/spend',
        admin(handleGetSpend)
    );

    // ── Models ───────────────────────────────────────────────────────
    httpRouter.add('GET', '/management/models', admin(handleListModels));
    httpRouter.add('POST', '/management/models', admin(handleCreateModel));
    httpRouter.add(
        'GET',
        '/management/models/providers',
        admin(handleListModelProviders)
    );
    httpRouter.add(
        'GET',
        '/management/models/providers/:key/models',
        admin(handleListProviderModels)
    );
    httpRouter.add(
        'GET',
        '/management/models/tags',
        admin(handleListModelTags)
    );
    httpRouter.add('GET', '/management/models/:modelId', admin(handleGetModel));
    httpRouter.add(
        'PATCH',
        '/management/models/:modelId',
        admin(handleUpdateModel)
    );
    httpRouter.add(
        'DELETE',
        '/management/models/:modelId',
        admin(handleDeleteModel)
    );
    httpRouter.add(
        'POST',
        '/management/models/:modelId/enable',
        admin(handleEnableModel)
    );
    httpRouter.add(
        'POST',
        '/management/models/:modelId/disable',
        admin(handleDisableModel)
    );

    // ── Tiers ────────────────────────────────────────────────────────
    httpRouter.add('GET', '/management/tiers', admin(handleListTiers));
    httpRouter.add('POST', '/management/tiers', admin(handleCreateTier));
    httpRouter.add('GET', '/management/tiers/:tierId', admin(handleGetTier));
    httpRouter.add(
        'PATCH',
        '/management/tiers/:tierId',
        admin(handleUpdateTier)
    );
    httpRouter.add(
        'DELETE',
        '/management/tiers/:tierId',
        admin(handleDeleteTier)
    );
    httpRouter.add(
        'POST',
        '/management/tiers/:tierId/enable',
        admin(handleEnableTier)
    );
    httpRouter.add(
        'POST',
        '/management/tiers/:tierId/disable',
        admin(handleDisableTier)
    );

    // ── Providers ────────────────────────────────────────────────────
    httpRouter.add(
        'GET',
        '/management/providers/templates',
        admin(handleListTemplates)
    );
    httpRouter.add(
        'POST',
        '/management/providers/rescan',
        admin(handleProviderRescan)
    );
    httpRouter.add('GET', '/management/providers', admin(handleListProviders));
    httpRouter.add(
        'POST',
        '/management/providers',
        admin(handleCreateProvider)
    );
    httpRouter.add(
        'GET',
        '/management/providers/:providerId',
        admin(handleGetProvider)
    );
    httpRouter.add(
        'PATCH',
        '/management/providers/:providerId',
        admin(handleUpdateProvider)
    );
    httpRouter.add(
        'DELETE',
        '/management/providers/:providerId',
        admin(handleDeleteProvider)
    );
    httpRouter.add(
        'POST',
        '/management/providers/:providerId/test',
        admin(handleTestConnection)
    );
    httpRouter.add(
        'POST',
        '/management/providers/:providerId/discover-models',
        admin(handleDiscoverModels)
    );
    httpRouter.add(
        'POST',
        '/management/providers/:providerId/sync-models',
        admin(handleSyncModels)
    );
    httpRouter.add(
        'POST',
        '/management/providers/:providerId/auth/start',
        admin(handleAuthStart)
    );
    httpRouter.add(
        'GET',
        '/management/providers/:providerId/auth/callback',
        admin(handleAuthCallback)
    );
    httpRouter.add(
        'GET',
        '/management/providers/:providerId/auth/pending/:flowId',
        admin(handleAuthPending)
    );
    httpRouter.add(
        'GET',
        '/management/providers/:providerId/accounts',
        admin(handleListAccounts)
    );
    httpRouter.add(
        'DELETE',
        '/management/providers/:providerId/accounts/:accountId',
        admin(handleDeleteAccount)
    );
    httpRouter.add(
        'POST',
        '/management/providers/:providerId/accounts/:accountId/reset-quota',
        admin(handleResetAccountQuota)
    );

    // ── Provider middlewares & backends ──────────────────────────────
    httpRouter.add(
        'GET',
        '/management/provider-middlewares',
        admin(handleListProviderMiddlewares)
    );
    httpRouter.add(
        'GET',
        '/management/backends',
        admin(handleListBackends)
    );
    httpRouter.add(
        'GET',
        '/management/providers/:providerId/middlewares',
        admin(handleListProviderMiddlewareBindings)
    );
    httpRouter.add(
        'POST',
        '/management/providers/:providerId/middlewares',
        admin(handleCreateProviderMiddlewareBinding)
    );
    httpRouter.add(
        'PATCH',
        '/management/providers/:providerId/middlewares/:bindingId',
        admin(handleUpdateProviderMiddlewareBinding)
    );
    httpRouter.add(
        'DELETE',
        '/management/providers/:providerId/middlewares/:bindingId',
        admin(handleDeleteProviderMiddlewareBinding)
    );

    // ── Middlewares (catalog) ────────────────────────────────────────
    httpRouter.add(
        'GET',
        '/management/middlewares',
        admin(handleListMiddlewares)
    );
    httpRouter.add(
        'POST',
        '/management/middlewares/rescan',
        admin(handleMiddlewareRescan)
    );
    httpRouter.add(
        'GET',
        '/management/middlewares/:id',
        admin(handleGetMiddleware)
    );
    httpRouter.add(
        'PATCH',
        '/management/middlewares/:id',
        admin(handleUpdateMiddleware)
    );

    // ── Middleware assignments (flat) ────────────────────────────────
    httpRouter.add(
        'POST',
        '/management/middlewares/assignments',
        admin(handleCreateAssignment)
    );
    httpRouter.add(
        'PATCH',
        '/management/middlewares/assignments/:assignmentId',
        admin(handleUpdateAssignment)
    );
    httpRouter.add(
        'DELETE',
        '/management/middlewares/assignments/:assignmentId',
        admin(handleDeleteAssignment)
    );

    // ── Model-scoped middlewares ─────────────────────────────────────
    httpRouter.add(
        'GET',
        '/management/models/:modelId/middlewares',
        admin(handleListModelMiddlewares)
    );
    httpRouter.add(
        'POST',
        '/management/models/:modelId/middlewares',
        admin(handleCreateModelMiddleware)
    );
    httpRouter.add(
        'POST',
        '/management/models/:modelId/middlewares/reorder',
        admin(handleReorderModelMiddlewares)
    );
    httpRouter.add(
        'PATCH',
        '/management/models/:modelId/middlewares/:assignmentId',
        admin(handleUpdateModelMiddleware)
    );
    httpRouter.add(
        'DELETE',
        '/management/models/:modelId/middlewares/:assignmentId',
        admin(handleDeleteModelMiddleware)
    );

    // ── Blacklist ────────────────────────────────────────────────────
    httpRouter.add(
        'GET',
        '/management/blacklist/rules',
        admin(handleListRules)
    );
    httpRouter.add(
        'POST',
        '/management/blacklist/rules',
        admin(handleCreateRule)
    );
    httpRouter.add(
        'GET',
        '/management/blacklist/rules/:ruleId',
        admin(handleGetRule)
    );
    httpRouter.add(
        'PATCH',
        '/management/blacklist/rules/:ruleId',
        admin(handleUpdateRule)
    );
    httpRouter.add(
        'DELETE',
        '/management/blacklist/rules/:ruleId',
        admin(handleDeleteRule)
    );
    httpRouter.add(
        'POST',
        '/management/blacklist/rules/:ruleId/enable',
        admin(handleEnableRule)
    );
    httpRouter.add(
        'POST',
        '/management/blacklist/rules/:ruleId/disable',
        admin(handleDisableRule)
    );

    // ── Cooldowns ────────────────────────────────────────────────────
    httpRouter.add('GET', '/management/cooldowns', admin(handleListCooldowns));
    httpRouter.add('DELETE', '/management/cooldowns', admin(handleClearAll));
    httpRouter.add(
        'DELETE',
        '/management/cooldowns/:modelId',
        admin(handleClearModel)
    );

    // ── Logs ─────────────────────────────────────────────────────────
    httpRouter.add('GET', '/management/logs', admin(handleListLogs));
    httpRouter.add('GET', '/management/logs/keys', admin(handleListLogKeys));
    httpRouter.add('GET', '/management/logs/:logId', admin(handleGetLog));

    // ── Metrics ──────────────────────────────────────────────────────
    httpRouter.add('GET', '/management/metrics/cost', admin(handleCostMetrics));
    httpRouter.add(
        'GET',
        '/management/metrics/usage',
        admin(handleUsageMetrics)
    );
    httpRouter.add(
        'GET',
        '/management/metrics/errors',
        admin(handleErrorMetrics)
    );
    httpRouter.add(
        'GET',
        '/management/metrics/activity',
        admin(handleActivityMetrics)
    );
    httpRouter.add(
        'GET',
        '/management/metrics/tokens',
        admin(handleTokenMetrics)
    );

    // ── Export ───────────────────────────────────────────────────────
    httpRouter.add(
        'GET',
        '/management/export/logs.csv',
        admin(handleExportCsv)
    );
    httpRouter.add(
        'GET',
        '/management/export/logs.json',
        admin(handleExportJson)
    );
    // ── Sessions ─────────────────────────────────────────────────────
    httpRouter.add('GET', '/management/sessions', admin(handleListSessions));
    httpRouter.add(
        'GET',
        '/management/sessions/:sessionId/logs',
        admin(handleGetSessionLogs)
    );
    httpRouter.add(
        'GET',
        '/management/sessions/:sessionId',
        admin(handleGetSession)
    );
    httpRouter.add('GET', '/management/agents/tree', admin(handleAgentsTree));

    // ── SSE streaming ────────────────────────────────────────────────
    httpRouter.add(
        'GET',
        '/management/logs/stream/sse',
        admin(handleLogStreamSse)
    );
    httpRouter.add(
        'GET',
        '/management/logs/stream/soul/:soulId',
        admin(handleLogStreamSoul)
    );

    // ── WebSocket streaming ──────────────────────────────────────────
    wsRouter.add('GET', '/management/ws/logs', admin(handleLogStreamWs));
    wsRouter.add('GET', '/management/ws/logs/soul/:soulId', admin(handleLogStreamWsSoul));
    wsRouter.add('GET', '/ws/logs', admin(handleLogStreamWs));
    wsRouter.add('GET', '/ws/logs/soul/:soulId', admin(handleLogStreamWsSoul));

    return { httpRouter, wsRouter };
}
