/**
 * Lookup functions that operate on a frozen runtime snapshot.
 *
 * Every addressable target is a model — direct or cascade — stored in
 * `snapshot.models`. Cascade models carry a `children` list loaded
 * from the `model_children` table. The dispatcher branches on
 * `model.strategyKind` (`'direct'` or `'cascade'`) to choose between
 * direct dispatch and cascade.
 */

/**
 * Resolve a model name to a ModelRecord from the snapshot.
 *
 * 1. Direct lookup by model key   (matches both direct and cascade models)
 * 2. Alias resolution
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
