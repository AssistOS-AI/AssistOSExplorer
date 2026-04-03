import { DEFAULTS } from './defaults.mjs';

/**
 * Merge environment variables with application defaults into a single
 * immutable config object consumed by the rest of the application.
 */
export function buildConfig(env) {
  return Object.freeze({
    env,
    defaults: DEFAULTS,
  });
}
