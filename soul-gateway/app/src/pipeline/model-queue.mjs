import { createLogger } from '../utils/logger.mjs';

const log = createLogger('model-queue');

// Per-model promise queue — each entry is the tail promise of that model's chain.
const queues = new Map();

/**
 * Acquire exclusive access to a model slot.
 * If another request is currently in-flight for this model, this call
 * awaits until that request releases its slot.
 *
 * @param {string} resolvedModel
 * @returns {Promise<Function>} release function — MUST be called when done
 */
export async function acquireModelSlot(resolvedModel) {
  const prev = queues.get(resolvedModel) || Promise.resolve();

  let release;
  const next = new Promise(resolve => { release = resolve; });

  // This caller's "next" becomes the new tail — subsequent callers wait on it.
  queues.set(resolvedModel, next);

  const waitStart = Date.now();
  await prev;
  const waitMs = Date.now() - waitStart;

  if (waitMs > 50) {
    log.info('Model slot acquired after wait', { model: resolvedModel, waitMs });
  }

  return release;
}
