import { createLogger } from '../utils/logger.mjs';
import { QueueTimeoutError } from '../utils/errors.mjs';

const log = createLogger('model-queue');

const QUEUE_TIMEOUT_MS = 60_000;

// Per-model semaphore state: { active: number, maxConcurrency: number, waiters: [] }
const semaphores = new Map();

function getSemaphore(model, maxConcurrency) {
  let sem = semaphores.get(model);
  if (!sem) {
    sem = { active: 0, maxConcurrency, waiters: [] };
    semaphores.set(model, sem);
  }
  // Update concurrency if it changed (e.g. model config edited)
  sem.maxConcurrency = maxConcurrency;
  return sem;
}

/**
 * Acquire a model slot with concurrency limit and timeout.
 *
 * @param {string} resolvedModel
 * @param {number} [maxConcurrency=3]
 * @returns {Promise<Function>} release function — MUST be called when done
 */
export async function acquireModelSlot(resolvedModel, maxConcurrency = 3) {
  const sem = getSemaphore(resolvedModel, maxConcurrency);

  if (sem.active < sem.maxConcurrency) {
    // Slot available immediately
    sem.active++;
    return () => release(sem);
  }

  // Must wait for a slot
  const waitStart = Date.now();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Remove from waiters
      const idx = sem.waiters.indexOf(entry);
      if (idx !== -1) sem.waiters.splice(idx, 1);
      reject(new QueueTimeoutError(resolvedModel, Date.now() - waitStart));
    }, QUEUE_TIMEOUT_MS);

    const entry = {
      resolve: () => {
        clearTimeout(timer);
        const waitMs = Date.now() - waitStart;
        if (waitMs > 50) {
          log.info('Model slot acquired after wait', { model: resolvedModel, waitMs });
        }
        resolve(() => release(sem));
      },
      reject,
      timer,
    };

    sem.waiters.push(entry);
  });
}

function release(sem) {
  if (sem.waiters.length > 0) {
    // Hand slot directly to next waiter
    const next = sem.waiters.shift();
    next.resolve();
  } else {
    sem.active--;
  }
}
