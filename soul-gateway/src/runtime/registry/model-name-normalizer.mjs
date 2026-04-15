/**
 * Normalize a user-supplied model name to its canonical snapshot key.
 *
 * Every addressable target — direct model or cascade model — lives in
 * `snapshot.models`. Cascade models are looked up by their model key
 * just like direct models.
 *
 * Resolution order:
 *
 *   1. Exact match in `snapshot.models`
 *   2. Alias match in `snapshot.aliases` → re-lookup in `snapshot.models`
 *   3. Bare model name → try every `<provider>/<name>` combination
 *      already in the models map
 *   4. Case-insensitive search across models and aliases
 *   5. Return the input unchanged
 *
 * Returns `{ normalized: string, kind: 'model' | 'unknown' }`.  The
 * `kind` field is always either `'model'` or `'unknown'` — there is
 * no separate `'tier'` kind anymore.  The dispatcher branches on
 * `model.strategyKind` to decide between direct dispatch and cascade.
 *
 * @module runtime/registry/model-name-normalizer
 */

export function normalizeModelName(input, snapshot) {
    if (!input || typeof input !== 'string') {
        return { normalized: input, kind: 'unknown' };
    }

    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return { normalized: trimmed, kind: 'unknown' };
    }

    // 1. Exact model match (covers both direct and cascade models)
    if (snapshot.models.has(trimmed)) {
        return { normalized: trimmed, kind: 'model' };
    }

    // 2. Alias match
    const aliasTarget = snapshot.aliases.get(trimmed);
    if (aliasTarget && snapshot.models.has(aliasTarget)) {
        return { normalized: aliasTarget, kind: 'model' };
    }

    // 3. Bare model name → try known provider prefixes
    if (!trimmed.includes('/')) {
        for (const [modelKey, modelRecord] of snapshot.models) {
            if (modelRecord?.strategyKind === 'cascade') continue;
            const slashIdx = modelKey.indexOf('/');
            if (slashIdx !== -1 && modelKey.slice(slashIdx + 1) === trimmed) {
                return { normalized: modelKey, kind: 'model' };
            }
        }

        // Aliases without provider prefix
        for (const [alias, target] of snapshot.aliases) {
            const slashIdx = alias.indexOf('/');
            if (slashIdx !== -1 && alias.slice(slashIdx + 1) === trimmed) {
                return { normalized: target, kind: 'model' };
            }
        }
    }

    // 4. Case-insensitive search
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

    // 5. Unresolvable
    return { normalized: trimmed, kind: 'unknown' };
}
