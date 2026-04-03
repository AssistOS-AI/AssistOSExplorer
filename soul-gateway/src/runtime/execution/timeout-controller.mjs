import { ProviderTimeoutError } from '../../core/errors.mjs';

/**
 * Create an AbortSignal that fires after timeoutMs.
 * Returns { signal, clear } — caller MUST call clear() to prevent leaks.
 */
export function withExecutionTimeout(timeoutMs, providerKey = 'unknown') {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new ProviderTimeoutError(providerKey));
  }, timeoutMs);

  return {
    signal: controller.signal,
    clear() { clearTimeout(timer); },
  };
}
