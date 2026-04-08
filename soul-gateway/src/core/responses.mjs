import { toHttpErrorPayload, GatewayError } from './errors.mjs';
import { CONTENT_TYPES, HEADER_NAMES } from './constants.mjs';

/**
 * Send a JSON response and end the connection.
 */
export function sendJson(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        [HEADER_NAMES.CONTENT_TYPE]: CONTENT_TYPES.JSON,
        [HEADER_NAMES.CONTENT_LENGTH]: Buffer.byteLength(payload),
        ...extraHeaders,
    });
    res.end(payload);
}

export function sendErrorPayload(
    res,
    status,
    { type, message, detail = null, extraHeaders = {} }
) {
    const body = {
        error: {
            message,
            type,
        },
    };

    if (detail != null) {
        body.error.detail = detail;
    }

    sendJson(res, status, body, extraHeaders);
}

/**
 * Send a gateway error as a JSON response.
 * Works with both typed GatewayErrors and unexpected errors.
 */
export function sendError(res, error) {
    const { status, body } = toHttpErrorPayload(error);
    const headers = {};
    if (error instanceof GatewayError && error.retryAfterSeconds != null) {
        headers[HEADER_NAMES.RETRY_AFTER] = String(error.retryAfterSeconds);
    }
    sendJson(res, status, body, headers);
}

/**
 * Send a plain-text response.
 */
export function sendText(res, status, text) {
    res.writeHead(status, {
        [HEADER_NAMES.CONTENT_TYPE]: CONTENT_TYPES.TEXT_PLAIN_UTF8,
        [HEADER_NAMES.CONTENT_LENGTH]: Buffer.byteLength(text),
    });
    res.end(text);
}
