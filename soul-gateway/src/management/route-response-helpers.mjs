import { CONTENT_TYPES, ERROR_MESSAGES, ERROR_TYPES, HTTP_STATUS } from '../core/constants.mjs';
import { sendErrorPayload, sendJson, sendText } from '../core/responses.mjs';

export function sendNotFound(res, resource = 'Resource') {
  sendErrorPayload(res, HTTP_STATUS.NOT_FOUND, {
    message: `${resource} not found`,
    type: ERROR_TYPES.NOT_FOUND,
  });
}

export function sendForbidden(res, message = ERROR_MESSAGES.FORBIDDEN) {
  sendErrorPayload(res, HTTP_STATUS.FORBIDDEN, {
    message,
    type: ERROR_TYPES.FORBIDDEN,
  });
}

export function sendConflict(res, message, detail = null) {
  sendErrorPayload(res, HTTP_STATUS.CONFLICT, {
    message,
    type: ERROR_TYPES.CONFLICT,
    detail,
  });
}

export function sendInternalError(res, message = ERROR_MESSAGES.INTERNAL_SERVER_ERROR, type = ERROR_TYPES.INTERNAL_ERROR) {
  sendErrorPayload(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
    message,
    type,
  });
}

export function sendOperationError(res, {
  status = HTTP_STATUS.INTERNAL_SERVER_ERROR,
  type = ERROR_TYPES.INTERNAL_ERROR,
  message = ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
  detail = null,
}) {
  sendErrorPayload(res, status, { type, message, detail });
}

export function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': CONTENT_TYPES.HTML_UTF8,
    'Content-Length': Buffer.byteLength(html),
    ...extraHeaders,
  });
  res.end(html);
}

export function sendOk(res, body = { ok: true }) {
  sendJson(res, HTTP_STATUS.OK, body);
}

export function sendStaticMissing(res) {
  sendText(res, HTTP_STATUS.NOT_FOUND, ERROR_MESSAGES.DASHBOARD_NOT_FOUND_TEXT);
}
