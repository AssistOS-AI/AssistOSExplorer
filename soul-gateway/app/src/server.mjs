import { createServer } from 'node:http';
import { handleCors, parseUrl, sendJson, sendError } from './utils/http-helpers.mjs';
import { createLogger } from './utils/logger.mjs';
import { pipeline } from './pipeline/pipeline.mjs';
import { anthropicProxy } from './pipeline/anthropic-proxy.mjs';
import { openaiResponsesProxy } from './pipeline/openai-responses-proxy.mjs';
import { apiRouter } from './api/router.mjs';
import { handleUpgrade } from './ws/upgrade.mjs';
import { serveDashboard } from './dashboard/serve.mjs';
import { isAuthenticated, handleLogin, handleLogout, redirectToLogin } from './dashboard/auth.mjs';
import { config } from './config.mjs';

const log = createLogger('server');

export function createAppServer() {
  const server = createServer(async (req, res) => {
    if (handleCors(req, res)) return;

    const { pathname, query } = parseUrl(req);

    try {
      // Skip WebSocket upgrade requests — handled by the 'upgrade' event
      if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
        return;
      }

      // Health check
      if (pathname === '/health' && req.method === 'GET') {
        return sendJson(res, { status: 'ok', uptime: process.uptime() });
      }

      // OpenAI-compatible agent endpoints
      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        return await pipeline(req, res);
      }
      // Anthropic Messages API passthrough
      if (pathname === '/v1/messages' && req.method === 'POST') {
        return await anthropicProxy(req, res);
      }
      // OpenAI Responses API passthrough
      if (pathname === '/v1/responses' && req.method === 'POST') {
        return await openaiResponsesProxy(req, res);
      }
      if (pathname === '/v1/models' && req.method === 'GET') {
        // Handled by API router (lists models for the authenticated family)
        return await apiRouter(req, res, pathname, query);
      }

      // Dashboard auth
      if (pathname === '/login') return handleLogin(req, res);
      if (pathname === '/logout') return handleLogout(req, res);

      // Protect dashboard and management API
      if (config.dashboardPassword && !isAuthenticated(req)) {
        // API calls from dashboard get 401 (so frontend can redirect)
        if (pathname.startsWith('/api/v1/')) {
          return sendError(res, 401, 'Authentication required');
        }
        return redirectToLogin(res);
      }

      // Management API
      if (pathname.startsWith('/api/v1/')) {
        return await apiRouter(req, res, pathname, query);
      }

      // Dashboard SPA (static files)
      if (pathname === '/' || pathname.startsWith('/css/') || pathname.startsWith('/js/') || pathname === '/favicon.ico') {
        return serveDashboard(req, res, pathname);
      }
      // Dashboard SPA routes (client-side routing)
      if (['logs', 'costs', 'errors', 'families', 'models', 'keys', 'blacklist'].some(p => pathname === `/${p}`)) {
        return serveDashboard(req, res, '/');
      }

      // WebSocket test page
      if (pathname === '/ws-test') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><body>
<h2>WebSocket Test</h2>
<div id="log" style="white-space:pre;font-family:monospace;"></div>
<script>
function log(msg){ document.getElementById('log').textContent += new Date().toISOString().substr(11,12)+' '+msg+'\\n'; }
function connect(){
  log('Connecting...');
  const ws = new WebSocket('ws://'+location.host+'/ws/v1/logs');
  ws.onopen = () => log('OPEN');
  ws.onclose = (e) => { log('CLOSE code='+e.code+' reason='+e.reason+' clean='+e.wasClean); setTimeout(connect,3000); };
  ws.onerror = (e) => log('ERROR '+e.type);
  ws.onmessage = (e) => log('MSG: '+e.data.substring(0,100));
}
connect();
</script></body></html>`);
        return;
      }

      sendError(res, 404, 'Not found');
    } catch (err) {
      log.error('Unhandled error', { path: pathname, error: err.message, stack: err.stack });
      if (!res.headersSent) {
        sendError(res, err.status || 500, err.message, err.type || 'internal_error');
      }
    }
  });

  // WebSocket upgrade
  server.on('upgrade', (req, socket, head) => {
    // Remove Node.js request timeout on upgraded sockets
    req.setTimeout(0);
    handleUpgrade(req, socket, head);
  });

  return server;
}

export function startServer(server) {
  return new Promise((resolve) => {
    server.listen(config.port, () => {
      log.info(`Soul Gateway listening on port ${config.port}`);
      resolve(server);
    });
  });
}
