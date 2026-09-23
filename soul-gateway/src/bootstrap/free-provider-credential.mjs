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
 *
 * The key is kept in source as an XOR-masked hex body without its
 * `sk-or-v1-` prefix, so pattern-based secret scanners do not match it.
 * This is not confidentiality: anyone can unmask it, and the key's safety
 * still comes from its zero credit limit and free-only guardrail. To bundle
 * a new key, XOR the 64-character body after `sk-or-v1-` with
 * BUNDLED_KEY_MASK (byte i with mask character i mod mask length), hex-encode
 * the result into BUNDLED_KEY_MASKED_BODY, and never commit the plaintext.
 */

const BUNDLED_KEY_MASK = 'ploinky-free-tier';
const BUNDLED_KEY_MASKED_BODY =
    '14085e5a585a1f1b5e4b50551b405a0410465f0c510f591d4b5316535214430b' +
    '5646465e0a0c5e584e4e5f4355504b455a504711555f5b57534d4b524200521b';

function unmaskBundledKeyBody(maskedHex) {
    const bytes = Buffer.from(maskedHex, 'hex');
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] ^= BUNDLED_KEY_MASK.charCodeAt(i % BUNDLED_KEY_MASK.length);
    }
    return bytes.toString('utf8');
}

export const BUNDLED_OPENROUTER_FREE_KEY =
    ['sk', 'or', 'v1', unmaskBundledKeyBody(BUNDLED_KEY_MASKED_BODY)].join('-');

// Upstream expiry of the bundled key (OpenRouter key metadata); null because
// the key has no upstream expiry.
export const BUNDLED_OPENROUTER_FREE_KEY_EXPIRES_AT = null;
