import {
    ProviderServerError,
    ProviderTimeoutError,
    ProviderUnavailableError,
} from '../../core/errors.mjs';
import {
    HTTP_STATUS,
    PROVIDER_MESSAGE_HINTS,
    PROVIDER_NETWORK_ERROR_CODES,
} from '../../core/constants.mjs';

export function getProviderStatus(error) {
    return error?.status || error?.statusCode || error?.httpStatus || null;
}

export function getProviderMessage(error) {
    const body = error?.body || {};
    return body.error?.message || body.message || error?.message || '';
}

export function getProviderErrorType(error) {
    const body = error?.body || {};
    return (
        body.error?.type || body.error?.code || body.__type || body.code || ''
    );
}

export function messageHasHint(message, hints = []) {
    const normalized = String(message || '').toLowerCase();
    return hints.some((hint) =>
        normalized.includes(String(hint).toLowerCase())
    );
}

export function looksLikeQuotaError(message) {
    return messageHasHint(message, PROVIDER_MESSAGE_HINTS.QUOTA);
}

export function looksLikeContentPolicyError(message) {
    return messageHasHint(message, PROVIDER_MESSAGE_HINTS.CONTENT_POLICY);
}

export function isTimeoutTransportCode(code) {
    return PROVIDER_NETWORK_ERROR_CODES.TIMEOUT.includes(code);
}

export function isUnavailableTransportCode(code) {
    return PROVIDER_NETWORK_ERROR_CODES.UNAVAILABLE.includes(code);
}

export function classifyTransportOrServerError(
    provider,
    error,
    fallbackStatus = HTTP_STATUS.INTERNAL_SERVER_ERROR
) {
    if (isTimeoutTransportCode(error?.code)) {
        return new ProviderTimeoutError(provider);
    }

    if (isUnavailableTransportCode(error?.code)) {
        return new ProviderUnavailableError(provider);
    }

    const status = getProviderStatus(error) || fallbackStatus;
    if (status === HTTP_STATUS.SERVICE_UNAVAILABLE) {
        return new ProviderUnavailableError(provider);
    }

    return new ProviderServerError(provider, status);
}
