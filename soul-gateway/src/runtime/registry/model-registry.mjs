/**
 * Lookup functions that operate on a frozen runtime snapshot.
 *
 * These are pure functions — they read from the snapshot and
 * never perform I/O or mutate any state.
 */

/**
 * Resolve a model name to a ModelRecord from the snapshot.
 *
 * 1. Direct lookup by model_key
 * 2. Alias resolution (alias -> model_key -> ModelRecord)
 *
 * Returns { model, resolvedVia } or null if unresolvable.
 *   resolvedVia: 'direct' | 'alias'
 */
export function resolveModel(snapshot, modelName) {
  // 1. Direct model lookup
  const direct = snapshot.models.get(modelName);
  if (direct) {
    return { model: direct, resolvedVia: 'direct' };
  }

  // 2. Alias resolution
  const aliasTarget = snapshot.aliases.get(modelName);
  if (aliasTarget) {
    const aliasModel = snapshot.models.get(aliasTarget);
    if (aliasModel) {
      return { model: aliasModel, resolvedVia: 'alias' };
    }
  }

  return null;
}

/**
 * Resolve a tier key to an ordered list of candidate models,
 * filtering out cooled-down models and traversing fallback tiers.
 *
 * Options:
 *   - skipCooldowns: boolean (default true) — exclude models in cooldown
 *   - maxDepth: number (default 10) — max fallback chain depth (prevents cycles)
 *
 * Returns {
 *   tier: TierRecord,
 *   candidates: Array<{ model: ModelRecord, tierKey: string, priority: number }>,
 *   fallbackChain: string[],  // tier keys traversed
 *   exhausted: boolean,       // true if all candidates were filtered out
 * } or null if the tier key is not found.
 */
export function resolveTier(snapshot, tierKey, { skipCooldowns = true, maxDepth = 10 } = {}) {
  const tier = snapshot.tiers.get(tierKey);
  if (!tier) return null;

  const candidates = [];
  const fallbackChain = [];
  const visited = new Set();

  let current = tier;
  let depth = 0;

  while (current && depth < maxDepth) {
    if (visited.has(current.tierKey)) break; // cycle guard
    visited.add(current.tierKey);
    fallbackChain.push(current.tierKey);

    for (const tm of current.models) {
      // Skip models that are disabled at the model level
      if (!tm.modelEnabled) continue;

      // Skip cooled-down models if requested
      if (skipCooldowns && snapshot.cooldowns.has(tm.modelKey)) continue;

      // Resolve the full model record
      const model = snapshot.models.get(tm.modelKey);
      if (!model) continue;

      candidates.push({
        model,
        tierKey: current.tierKey,
        priority: tm.priority,
        settings: tm.settings,
      });
    }

    // Follow fallback chain
    if (current.fallbackTierId) {
      current = findTierById(snapshot, current.fallbackTierId);
    } else {
      current = null;
    }
    depth++;
  }

  return {
    tier,
    candidates,
    fallbackChain,
    exhausted: candidates.length === 0,
  };
}

// ── internal ─────────────────────────────────────────────────────────

/**
 * Find a tier by its UUID id within the snapshot.
 * The snapshot keys tiers by tier_key, so we need a linear scan by id.
 */
function findTierById(snapshot, tierId) {
  for (const tier of snapshot.tiers.values()) {
    if (tier.id === tierId) return tier;
  }
  return null;
}
