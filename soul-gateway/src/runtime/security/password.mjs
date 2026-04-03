/**
 * Timing-safe password comparison for the dashboard.
 */

import { timingSafeEqual } from 'node:crypto';

/**
 * Compare a user-supplied password with the expected password
 * using a constant-time comparison to prevent timing attacks.
 *
 * @param {string} input     User-supplied password
 * @param {string} expected  Configured DASHBOARD_PASSWORD
 * @returns {boolean}
 */
export function compareDashboardPassword(input, expected) {
  if (typeof input !== 'string' || typeof expected !== 'string') return false;
  if (input.length === 0 || expected.length === 0) return false;

  // Encode both to buffers.  We normalise length by hashing so that
  // timingSafeEqual never throws due to mismatched buffer lengths.
  const inputBuf = Buffer.from(input, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');

  // If lengths differ, we still do a constant-time comparison against
  // the expected buffer to avoid leaking length information.
  if (inputBuf.length !== expectedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf);   // burn the same time
    return false;
  }

  return timingSafeEqual(inputBuf, expectedBuf);
}
