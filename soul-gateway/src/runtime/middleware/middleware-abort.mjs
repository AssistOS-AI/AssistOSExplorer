/**
 * Helpers that middleware hooks call to abort the pipeline.
 *
 * Both throw — callers in the engine catch and handle accordingly.
 */

import { MiddlewareAbortError, SyntheticResponseAbort } from '../../core/errors.mjs';

/**
 * Abort the pipeline with a synthetic (cached / fabricated) response.
 * The response object is attached to the thrown error so the engine
 * can return it directly to the client.
 *
 * @param {string} middlewareName - Key of the aborting middleware.
 * @param {Object} response      - The synthetic response payload.
 * @throws {SyntheticResponseAbort}
 */
export function abortSuccess(middlewareName, response) {
  const err = new SyntheticResponseAbort(middlewareName);
  err.syntheticResponse = response;
  throw err;
}

/**
 * Abort the pipeline with an HTTP error.
 *
 * @param {string} middlewareName - Key of the aborting middleware.
 * @param {number} httpStatus     - Status code to send.
 * @param {string} message        - Human-readable error message.
 * @throws {MiddlewareAbortError}
 */
export function abortError(middlewareName, httpStatus, message) {
  throw new MiddlewareAbortError(middlewareName, httpStatus, message);
}
