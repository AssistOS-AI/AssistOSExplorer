import crypto from 'node:crypto';

/**
 * request-hash.mjs — self-contained copy of Ploinky's request-content-hash
 * (`rch`) primitives.
 *
 * This is a BYTE-IDENTICAL copy of `ploinky/Agent/lib/requestHash.mjs`. The
 * Ploinky router and the receiving AgentServer recompute `rch` over the exact
 * raw request body bytes they receive and reject any divergence, so Soul
 * Gateway MUST hash with the exact same code when it signs an Agent Assertion
 * for a router-mediated OpenAI call. The implementation depends only on
 * `node:crypto`.
 *
 * The copy is deliberate, not an import. The canonical Ploinky module lives
 * under the `Agent/` tree that is mounted into every agent container; it is not
 * part of the upstream `achillesAgentLib` npm package that Soul Gateway depends
 * on. Importing across that boundary is not possible at runtime, so this file
 * mirrors the upstream logic and a golden-vector test guards against drift.
 *
 * `canonicalJson` here is intentionally STRICTER than the lenient variant in
 * `achillesAgentLib/jwt/jwtSign.mjs` (which coerces `undefined` to `null`). A
 * request hash must be unambiguous, so `undefined`, functions, symbols,
 * bigints, and non-finite numbers throw rather than being silently dropped or
 * coerced. Using the lenient variant would produce a DIFFERENT hash and break
 * the handshake — do not substitute it.
 */

export function canonicalJson(value) {
    const valueType = typeof value;
    if (value === undefined || valueType === 'function' || valueType === 'symbol') {
        throw new Error('canonicalJson: undefined, function, and symbol values are not allowed');
    }
    if (value === null) {
        return 'null';
    }
    if (valueType === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error('canonicalJson: non-finite numbers are not allowed');
        }
        return JSON.stringify(value);
    }
    if (valueType === 'boolean' || valueType === 'string') {
        return JSON.stringify(value);
    }
    if (valueType === 'bigint') {
        throw new Error('canonicalJson: bigint values are not allowed');
    }
    if (Array.isArray(value)) {
        // Array order is significant and preserved; holes/`undefined` entries throw.
        return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
    }
    if (valueType === 'object') {
        // Object key order is NOT significant: keys are sorted lexicographically
        // so `{a,b}` and `{b,a}` hash identically.
        const keys = Object.keys(value).sort();
        const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
        return `{${parts.join(',')}}`;
    }
    throw new Error(`canonicalJson: unsupported value type ${valueType}`);
}

export function sha256b64url(input) {
    return crypto.createHash('sha256').update(String(input), 'utf8').digest('base64url');
}

export function sha256RawBodyHash(body = Buffer.alloc(0)) {
    const bytes = Buffer.isBuffer(body)
        ? body
        : Buffer.from(body === undefined || body === null ? '' : body);
    return crypto.createHash('sha256').update(bytes).digest('base64url');
}

// Generic entry point: hash the canonical JSON of an already-assembled input.
export function computeRch(input) {
    return sha256b64url(canonicalJson(input));
}

// HTTP surface. `bodyHash` is base64url(sha256(rawBodyBytes)) computed by the
// caller; the query string participates in the signed surface but is otherwise
// opaque (it never decides HTTP whitelist access — that is a separate concern).
export function computeRchHttp({ method, path, query, bodyHash }) {
    return computeRch({
        method: String(method ?? ''),
        path: String(path ?? ''),
        query: query === undefined || query === null ? '' : String(query),
        bodyHash: String(bodyHash ?? ''),
    });
}

export default {
    canonicalJson,
    sha256b64url,
    sha256RawBodyHash,
    computeRch,
    computeRchHttp,
};
