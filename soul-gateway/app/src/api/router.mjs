import { matchPath, sendError } from '../utils/http-helpers.mjs';
import { handleSoulFamilies } from './soul-families.mjs';
import { handleModels } from './models.mjs';
import { handleKeys } from './keys.mjs';
import { handleBlacklist } from './blacklist.mjs';
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

  // Soul Families
  if (pathname === '/api/v1/soul-families') {
    if (method === 'GET') return handleSoulFamilies.list(req, res, query);
    if (method === 'POST') return handleSoulFamilies.create(req, res);
  }
  let params = matchPath('/api/v1/soul-families/:id', pathname);
  if (params) {
    if (method === 'GET') return handleSoulFamilies.get(req, res, params);
    if (method === 'PUT') return handleSoulFamilies.update(req, res, params);
    if (method === 'DELETE') return handleSoulFamilies.remove(req, res, params);
  }

  // Models
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
  params = matchPath('/api/v1/models/:id', pathname);
  if (params) {
    if (method === 'PUT') return handleModels.update(req, res, params);
    if (method === 'DELETE') return handleModels.remove(req, res, params);
  }
  params = matchPath('/api/v1/models/:id/toggle', pathname);
  if (params) {
    if (method === 'PUT') return handleModels.toggle(req, res, params);
  }

  // API Keys
  if (pathname === '/api/v1/keys') {
    if (method === 'GET') return handleKeys.list(req, res, query);
    if (method === 'POST') return handleKeys.create(req, res);
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
    if (method === 'GET') return handleAgents.tree(req, res);
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
