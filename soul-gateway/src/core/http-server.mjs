import { createServer } from 'node:http';
import { parseUrl } from './router.mjs';
import { sendError, sendErrorPayload } from './responses.mjs';
import { createRequestId } from './request-id.mjs';
import { GatewayError, InternalServerError } from './errors.mjs';
import { ERROR_MESSAGES, ERROR_TYPES, HEADER_NAMES, HTTP_STATUS } from './constants.mjs';

/**
 * Create the HTTP server, wire request routing and WebSocket upgrades.
 *
 * @param {object} appCtx        - application context
 * @param {object} httpRouter    - router returned by createRouter()
 * @param {object} [wsRouter]    - optional router for WebSocket upgrade paths
 * @returns {import('node:http').Server}
 */
export function createHttpServer(appCtx, httpRouter, wsRouter) {
  const { config, log } = appCtx;
  const prefix = config.defaults.requestIdPrefix;

  const server = createServer(async (req, res) => {
    const requestId = createRequestId(prefix);
    res.setHeader(HEADER_NAMES.X_REQUEST_ID, requestId);

    const { pathname, query } = parseUrl(req);
    let match = httpRouter.match(req.method, pathname);

    // Fallback to management router if registered
    if (!match && appCtx.services.managementHttpRouter) {
      match = appCtx.services.managementHttpRouter.match(req.method, pathname);
    }

    if (!match) {
      sendErrorPayload(res, HTTP_STATUS.NOT_FOUND, {
        message: ERROR_MESSAGES.NOT_FOUND,
        type: ERROR_TYPES.NOT_FOUND,
      });
      return;
    }

    try {
      await match.handler({ req, res, params: match.params, query, requestId, appCtx });
    } catch (err) {
      if (err instanceof GatewayError) {
        sendError(res, err);
      } else {
        log.error('unhandled request error', { path: pathname, error: err.message, stack: err.stack });
        sendError(res, new InternalServerError());
      }
    }
  });

  // WebSocket upgrade handling
  if (wsRouter) {
    server.on('upgrade', async (req, socket, head) => {
      const { pathname } = parseUrl(req);
      let match = wsRouter.match('GET', pathname);

      if (!match && appCtx.services.managementWsRouter) {
        match = appCtx.services.managementWsRouter.match('GET', pathname);
      }

      if (!match) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      try {
        await match.handler({ req, socket, head, params: match.params, appCtx });
      } catch (err) {
        if (err instanceof GatewayError && err.httpStatus === 401) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        } else {
          log.error('ws upgrade error', { path: pathname, error: err.message });
        }
        socket.destroy();
      }
    });
  }

  return server;
}
