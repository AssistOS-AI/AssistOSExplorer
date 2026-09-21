/**
 * Bundled restricted credential for the first-start free provider.
 *
 * This OpenRouter key belongs to a dedicated free-tier account whose key has
 * a zero credit limit and a workspace guardrail that allows only free
 * models; paid requests are rejected upstream. Its daily free-request
 * allowance is shared by every installation that uses it, so it offers a
 * working first start, not unlimited or guaranteed capacity.
 *
 * Keep this module backend-only. It must never be imported by dashboard,
 * browser, or public model-listing code, and the key is stored encrypted in
 * the provider account table on first start. An administrator can replace
 * it with their own key through the management dashboard, or supply
 * OPENROUTER_API_KEY before the first start.
 */

export const BUNDLED_OPENROUTER_FREE_KEY = "REDACTED-OPENROUTER-KEY";

// Upstream expiry of the bundled key (OpenRouter key metadata).
export const BUNDLED_OPENROUTER_FREE_KEY_EXPIRES_AT = "2027-03-20T10:38:56.994Z";
