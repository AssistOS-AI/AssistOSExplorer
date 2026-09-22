/**
 * Timer delay ceiling for execution deadlines.
 *
 * A Node timer stores its delay in a signed 32-bit integer. A larger delay
 * overflows: Node emits `TimeoutOverflowWarning` and fires the timer after
 * 1 ms instead. A deadline configured above the ceiling must therefore
 * become the longest timer available, never an almost immediate one — an
 * operator who writes a very large `firstContentTimeoutMs` means "practically
 * never", and a stream cut off after a millisecond would be the opposite of
 * what they asked for.
 *
 * `Infinity` is a configured "never" and becomes the ceiling, like any other
 * over-large value. A delay that is not a number at all, or is zero or
 * negative, becomes 0 — the value a timer already coerces it to. Most
 * execution deadlines pass a checked positive number, but the retry backoff
 * is computed from the model row's `retry_policy` values without a numeric
 * guard, so a non-numeric entry there reaches a timer as `NaN`.
 * Fire-immediately is the right reading of a broken backoff; the point of
 * deciding it here is that it no longer depends on how a timer coerces its
 * argument.
 *
 * @module runtime/execution/timer-delay
 */

export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * @param {number} delayMs
 * @returns {number} a delay a timer can represent: 0 to `MAX_TIMER_DELAY_MS`
 */
export function clampTimerDelay(delayMs) {
    const numeric = Number(delayMs);
    if (Number.isNaN(numeric) || numeric <= 0) return 0;
    return numeric > MAX_TIMER_DELAY_MS ? MAX_TIMER_DELAY_MS : numeric;
}

export default { MAX_TIMER_DELAY_MS, clampTimerDelay };
