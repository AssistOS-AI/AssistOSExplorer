/**
 * Deep-merge middleware settings with null-means-use-default semantics.
 *
 * @param {Object} defaults  - The middleware's default_settings from the DB/meta.
 * @param {Object} overrides - Per-assignment settings that take precedence.
 * @returns {Readonly<Object>} Merged frozen object.
 */
export function mergeMiddlewareSettings(defaults, overrides) {
  if (!defaults && !overrides) return Object.freeze({});
  if (!overrides) return Object.freeze(deepClone(defaults || {}));
  if (!defaults) return Object.freeze(deepClone(overrides));

  const merged = deepMerge(deepClone(defaults), overrides);
  return Object.freeze(merged);
}

// ── internals ──────────────────────────────────────────────────────────

/**
 * Recursively merge `src` into `target`.
 * - `null` values in src are ignored (keep default).
 * - Arrays are replaced wholesale (no element-wise merge).
 * - Plain objects recurse.
 * - Everything else overwrites.
 */
function deepMerge(target, src) {
  for (const key of Object.keys(src)) {
    const val = src[key];

    // null in overrides => keep default
    if (val === null) continue;

    if (isPlainObject(val) && isPlainObject(target[key])) {
      deepMerge(target[key], val);
    } else {
      target[key] = deepClone(val);
    }
  }
  return target;
}

function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepClone);
  const out = {};
  for (const k of Object.keys(obj)) {
    out[k] = deepClone(obj[k]);
  }
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
