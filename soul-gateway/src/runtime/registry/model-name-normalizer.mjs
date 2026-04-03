/**
 * Normalizes legacy and variant model name formats into canonical form.
 *
 * The Soul Gateway has gone through several naming conventions:
 *   - Old format: "axl/deep" (tier prefix)
 *   - Provider-prefixed: "openai/gpt-4o"
 *   - Bare model names: "gpt-4o"
 *   - Mode aliases: using "mode" as synonym for "tier"
 *
 * This module handles all the transformations needed to resolve
 * user input against the current snapshot's model/tier keys.
 */

/**
 * Normalize a user-supplied model name to its canonical snapshot key.
 *
 * Resolution order:
 *   1. Exact match in models map -> return as-is
 *   2. Exact match in aliases map -> return the alias target
 *   3. Exact match in tiers map -> return as-is (caller handles tier resolution)
 *   4. Legacy "mode:" prefix -> strip and retry as tier key
 *   5. Bare name -> try "provider/name" combinations for all known providers
 *   6. Case-insensitive search across models and aliases
 *   7. Return the input unchanged (let the caller handle the 404)
 *
 * Returns { normalized: string, kind: 'model' | 'tier' | 'unknown' }
 */
export function normalizeModelName(input, snapshot) {
  if (!input || typeof input !== 'string') {
    return { normalized: input, kind: 'unknown' };
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { normalized: trimmed, kind: 'unknown' };
  }

  // 1. Exact model match
  if (snapshot.models.has(trimmed)) {
    return { normalized: trimmed, kind: 'model' };
  }

  // 2. Alias match
  const aliasTarget = snapshot.aliases.get(trimmed);
  if (aliasTarget && snapshot.models.has(aliasTarget)) {
    return { normalized: aliasTarget, kind: 'model' };
  }

  // 3. Exact tier match
  if (snapshot.tiers.has(trimmed)) {
    return { normalized: trimmed, kind: 'tier' };
  }

  // 4. Legacy "mode:" prefix -> treat as tier
  //    e.g. "mode:fast" -> "axl/fast" (try with axl/ prefix)
  //    or "mode:axl/fast" -> "axl/fast"
  if (trimmed.startsWith('mode:')) {
    const modeValue = trimmed.slice(5).trim();
    if (snapshot.tiers.has(modeValue)) {
      return { normalized: modeValue, kind: 'tier' };
    }
    // Try adding axl/ prefix for legacy names like "mode:fast" -> "axl/fast"
    const withPrefix = `axl/${modeValue}`;
    if (snapshot.tiers.has(withPrefix)) {
      return { normalized: withPrefix, kind: 'tier' };
    }
  }

  // 5. Bare model name -> try known provider prefixes
  //    e.g. "gpt-4o" -> look for "openai/gpt-4o", "copilot/gpt-4o", etc.
  if (!trimmed.includes('/')) {
    for (const [modelKey] of snapshot.models) {
      const slashIdx = modelKey.indexOf('/');
      if (slashIdx !== -1 && modelKey.slice(slashIdx + 1) === trimmed) {
        return { normalized: modelKey, kind: 'model' };
      }
    }

    // Also check aliases without provider prefix
    for (const [alias, target] of snapshot.aliases) {
      const slashIdx = alias.indexOf('/');
      if (slashIdx !== -1 && alias.slice(slashIdx + 1) === trimmed) {
        return { normalized: target, kind: 'model' };
      }
    }

    // Try as tier key without prefix (e.g. "fast" -> "axl/fast")
    const withAxlPrefix = `axl/${trimmed}`;
    if (snapshot.tiers.has(withAxlPrefix)) {
      return { normalized: withAxlPrefix, kind: 'tier' };
    }
  }

  // 6. Case-insensitive search
  const lower = trimmed.toLowerCase();

  for (const [modelKey] of snapshot.models) {
    if (modelKey.toLowerCase() === lower) {
      return { normalized: modelKey, kind: 'model' };
    }
  }

  for (const [alias, target] of snapshot.aliases) {
    if (alias.toLowerCase() === lower) {
      return { normalized: target, kind: 'model' };
    }
  }

  for (const [tierKey] of snapshot.tiers) {
    if (tierKey.toLowerCase() === lower) {
      return { normalized: tierKey, kind: 'tier' };
    }
  }

  // 7. Unresolvable — return as-is
  return { normalized: trimmed, kind: 'unknown' };
}
