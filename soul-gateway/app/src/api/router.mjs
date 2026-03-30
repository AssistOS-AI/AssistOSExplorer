import { matchPath, sendError } from '../utils/http-helpers.mjs';
import { handleModels } from './models.mjs';
import { handleTiers } from './tiers.mjs';
import { handleKeys } from './keys.mjs';
import { handleProviders } from './providers.mjs';
import { handleBlacklist } from './blacklist.mjs';
import { handleCooldowns } from './cooldowns.mjs';
import { handleMiddlewares } from './middlewares.mjs';
import { handleLogs } from './logs.mjs';
import { handleMetrics } from './metrics.mjs';
import { handleExport } from './export.mjs';
import { handleAgents } from './agents.mjs';
import { handleSseStream } from '../ws/log-stream.mjs';

/**
 * Route management API requests.
 */
export async function apiRouter(req, res, pathname, query) {
  const method = req.method;

  // /v1/models — agent-facing model list
  if (pathname === '/v1/models' && method === 'GET') {
    return handleModels.list(req, res, query);
  }

  // /v1/tiers — agent-facing tier list
  if (pathname === '/v1/tiers' && method === 'GET') {
    return handleTiers.list(req, res);
  }

  // Providers (templates route MUST come before :id to avoid matching 'templates' as an id)
  if (pathname === '/api/v1/providers/templates') {
    if (method === 'GET') return handleProviders.templates(req, res);
  }
  let params = matchPath('/api/v1/providers/:id/test', pathname);
  if (params) {
    if (method === 'POST') return handleProviders.test(req, res, params);
  }
  params = matchPath('/api/v1/providers/:id/sync', pathname);
  if (params) {
    if (method === 'POST') return handleProviders.sync(req, res, params);
  }
  params = matchPath('/api/v1/providers/:id/models', pathname);
  if (params) {
    if (method === 'GET') return handleProviders.discover(req, res, params);
  }
  // Provider auth routes (must come before /api/v1/providers/:id)
  params = matchPath('/api/v1/providers/:id/auth/accounts/:idx', pathname);
  if (params) {
    if (method === 'DELETE') return handleProviders.authRemoveAccount(req, res, params);
  }
  params = matchPath('/api/v1/providers/:id/auth/reset-quota', pathname);
  if (params) {
    if (method === 'POST') return handleProviders.authResetQuota(req, res, params);
  }
  params = matchPath('/api/v1/providers/:id/auth/status', pathname);
  if (params) {
    if (method === 'GET') return handleProviders.authStatus(req, res, params);
  }
  params = matchPath('/api/v1/providers/:id/auth/start', pathname);
  if (params) {
    if (method === 'POST') return handleProviders.authStart(req, res, params);
  }
  params = matchPath('/api/v1/providers/:id/auth/poll', pathname);
  if (params) {
    if (method === 'GET') return handleProviders.authPoll(req, res, params);
  }
  params = matchPath('/api/v1/providers/:id/auth/callback', pathname);
  if (params) {
    if (method === 'POST') return handleProviders.authCallback(req, res, params);
  }
  if (pathname === '/api/v1/providers') {
    if (method === 'GET') return handleProviders.list(req, res);
    if (method === 'POST') return handleProviders.create(req, res);
  }
  params = matchPath('/api/v1/providers/:id', pathname);
  if (params) {
    if (method === 'PUT') return handleProviders.update(req, res, params);
    if (method === 'DELETE') return handleProviders.remove(req, res, params);
  }

  // Models
  if (pathname === '/api/v1/models/tags') {
    if (method === 'GET') return handleModels.tags(req, res);
  }
  params = matchPath('/api/v1/models/providers/:key/models', pathname);
  if (params) {
    if (method === 'GET') return handleModels.providerModels(req, res, params);
  }
  if (pathname === '/api/v1/models/providers') {
    if (method === 'GET') return handleModels.providers(req, res);
  }
  if (pathname === '/api/v1/models') {
    if (method === 'GET') return handleModels.list(req, res, query);
    if (method === 'POST') return handleModels.create(req, res);
  }
  // Model-middleware routes (must come before /api/v1/models/:id catch-all)
  params = matchPath('/api/v1/models/:id/middlewares/reorder', pathname);
  if (params) {
    if (method === 'PUT') return handleMiddlewares.reorderModelMiddlewares(req, res, params);
  }
  params = matchPath('/api/v1/models/:id/middlewares/:mwId', pathname);
  if (params) {
    if (method === 'PUT') return handleMiddlewares.updateModelMiddleware(req, res, params);
    if (method === 'DELETE') return handleMiddlewares.removeModelMiddleware(req, res, params);
  }
  params = matchPath('/api/v1/models/:id/middlewares', pathname);
  if (params) {
    if (method === 'GET') return handleMiddlewares.modelMiddlewares(req, res, params);
    if (method === 'POST') return handleMiddlewares.assignToModel(req, res, params);
  }
  params = matchPath('/api/v1/models/:id', pathname);
  if (params) {
    if (method === 'PUT') return handleModels.update(req, res, params);
    if (method === 'DELETE') return handleModels.remove(req, res, params);
  }
  params = matchPath('/api/v1/models/:id/toggle', pathname);
  if (params) {
    if (method === 'PUT') return handleModels.toggle(req, res, params);
  }

  // Middlewares
  if (pathname === '/api/v1/middlewares/rescan') {
    if (method === 'POST') return handleMiddlewares.rescan(req, res);
  }
  if (pathname === '/api/v1/middlewares') {
    if (method === 'GET') return handleMiddlewares.list(req, res);
  }
  params = matchPath('/api/v1/middlewares/:id', pathname);
  if (params) {
    if (method === 'GET') return handleMiddlewares.get(req, res, params);
    if (method === 'PUT') return handleMiddlewares.update(req, res, params);
  }

  // Tier-middleware routes (must come before /api/v1/tiers/:id to avoid ID catch-all)
  params = matchPath('/api/v1/tiers/:id/middlewares/reorder', pathname);
  if (params) {
    if (method === 'PUT') return handleMiddlewares.reorder(req, res, params);
  }
  params = matchPath('/api/v1/tiers/:id/middlewares/:mwId', pathname);
  if (params) {
    if (method === 'PUT') return handleMiddlewares.updateTierMiddleware(req, res, params);
    if (method === 'DELETE') return handleMiddlewares.removeTierMiddleware(req, res, params);
  }
  params = matchPath('/api/v1/tiers/:id/middlewares', pathname);
  if (params) {
    if (method === 'GET') return handleMiddlewares.tierMiddlewares(req, res, params);
    if (method === 'POST') return handleMiddlewares.assignToTier(req, res, params);
  }

  // Tiers
  if (pathname === '/api/v1/tiers') {
    if (method === 'GET') return handleTiers.list(req, res);
    if (method === 'POST') return handleTiers.create(req, res);
  }
  params = matchPath('/api/v1/tiers/:id', pathname);
  if (params) {
    if (method === 'PUT') return handleTiers.update(req, res, params);
    if (method === 'DELETE') return handleTiers.remove(req, res, params);
  }
  params = matchPath('/api/v1/tiers/:id/toggle', pathname);
  if (params) {
    if (method === 'PUT') return handleTiers.toggle(req, res, params);
  }

  // API Keys
  if (pathname === '/api/v1/keys') {
    if (method === 'GET') return handleKeys.list(req, res, query);
    if (method === 'POST') return handleKeys.create(req, res);
  }
  params = matchPath('/api/v1/keys/:id/reset-budget', pathname);
  if (params) {
    if (method === 'POST') return handleKeys.resetBudget(req, res, params);
  }
  params = matchPath('/api/v1/keys/:id', pathname);
  if (params) {
    if (method === 'PUT') return handleKeys.update(req, res, params);
    if (method === 'DELETE') return handleKeys.revoke(req, res, params);
  }

  // Blacklist
  if (pathname === '/api/v1/blacklist') {
    if (method === 'GET') return handleBlacklist.list(req, res, query);
    if (method === 'POST') return handleBlacklist.create(req, res);
  }
  params = matchPath('/api/v1/blacklist/:id', pathname);
  if (params) {
    if (method === 'PUT') return handleBlacklist.update(req, res, params);
    if (method === 'DELETE') return handleBlacklist.remove(req, res, params);
  }

  // Cooldowns
  if (pathname === '/api/v1/cooldowns') {
    if (method === 'GET') return handleCooldowns.list(req, res);
    if (method === 'DELETE') return handleCooldowns.clearAll(req, res);
  }
  params = matchPath('/api/v1/cooldowns/:model', pathname);
  if (params) {
    if (method === 'DELETE') return handleCooldowns.clear(req, res, params);
  }

  // Agents & Sessions
  if (pathname === '/api/v1/agents') {
    if (method === 'GET') return handleAgents.list(req, res, query);
  }
  if (pathname === '/api/v1/sessions') {
    if (method === 'GET') return handleAgents.sessions(req, res, query);
  }
  params = matchPath('/api/v1/sessions/:id/logs', pathname);
  if (params) {
    if (method === 'GET') return handleAgents.sessionLogs(req, res, params, query);
  }
  if (pathname === '/api/v1/tree') {
    if (method === 'GET') return handleAgents.tree(req, res, {}, query);
  }

  // Logs
  if (pathname === '/api/v1/logs/stream') {
    if (method === 'GET') return handleSseStream(req, res, query);
  }
  if (pathname === '/api/v1/logs') {
    if (method === 'GET') return handleLogs.list(req, res, query);
  }
  params = matchPath('/api/v1/logs/:id', pathname);
  if (params) {
    if (method === 'GET') return handleLogs.get(req, res, params);
  }

  // Metrics
  if (pathname === '/api/v1/metrics/costs') {
    if (method === 'GET') return handleMetrics.costs(req, res, query);
  }
  if (pathname === '/api/v1/metrics/usage') {
    if (method === 'GET') return handleMetrics.usage(req, res, query);
  }
  if (pathname === '/api/v1/metrics/activity') {
    if (method === 'GET') return handleMetrics.activity(req, res, query);
  }
  if (pathname === '/api/v1/metrics/errors') {
    if (method === 'GET') return handleMetrics.errors(req, res, query);
  }
  if (pathname === '/api/v1/metrics/tokens') {
    if (method === 'GET') return handleMetrics.tokens(req, res, query);
  }

  // Export
  if (pathname === '/api/v1/export') {
    if (method === 'GET') return handleExport(req, res, query);
  }

  sendError(res, 404, 'API endpoint not found');
}
