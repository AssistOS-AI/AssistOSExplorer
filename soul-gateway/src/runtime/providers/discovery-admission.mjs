/**
 * Catalog-sync admission: which discovered models a sync may store, and
 * whether an incoming catalog carries enough information to disable rows.
 *
 * Every sync path (startup, periodic, manual, key replacement, OAuth
 * completion, caller-supplied discoveries) reaches `syncProviderModels`, which
 * applies this module, so the rules hold for every caller.
 *
 * @module runtime/providers/discovery-admission
 */

import {
    isFreeOnlyProvider,
    isGeneralChatModelId,
} from './free-model-policy.mjs';
import { TAG_TIER_EXCLUDED_MODEL_IDS } from '../../bootstrap/free-model-catalog.mjs';
import { EXCLUDED_FROM_TAG_TIERS_METADATA_KEY } from '../../bootstrap/reconcile-tag-tiers.mjs';

// The approved free identifier form is case-insensitive, so an upstream that
// reports the same model with different letter case must still be matched.
const TAG_TIER_EXCLUDED_IDS = new Set(
    TAG_TIER_EXCLUDED_MODEL_IDS.map((id) => id.toLowerCase())
);

function isTagTierExcludedId(providerModelId) {
    return (
        typeof providerModelId === 'string' &&
        TAG_TIER_EXCLUDED_IDS.has(providerModelId.toLowerCase())
    );
}

function discoveryModelId(discovery) {
    return discovery?.providerModelId ?? discovery?.modelId ?? discovery?.id;
}

/**
 * A free-only provider stores only general chat models with an approved
 * free ID whose normalized pricing is free. Guard, moderation, safety and
 * embedding models answer with verdicts or vectors, never assistant text.
 */
export function isAdmissibleFreeDiscovery(discovery) {
    const pricingMode = discovery?.pricingMode ?? discovery?.pricing?.mode;
    return (
        isGeneralChatModelId(discoveryModelId(discovery)) &&
        (discovery?.isFree === true || pricingMode === 'free')
    );
}

/**
 * Decide what a sync stores and whether it may disable missing rows.
 *
 * An empty incoming list is uninformative (it can mean an upstream outage or
 * a discovery fallback) and never disables rows. A list that upstream
 * returned non-empty but that has no admissible entry is policy-filtered: the
 * upstream answered, nothing on it is allowed, so previously synced rows are
 * disabled. The backend marks a list it filtered itself with the
 * non-enumerable `policyFiltered` property, which `.filter()` would drop, so
 * the decision reads it from the original array before any filtering.
 *
 * @param {object} providerRecord normalized provider record
 * @param {Array<object>} discoveries
 * @returns {{ admitted: object[], emptyDiscovery: boolean, policyFiltered: boolean }}
 */
export function admitDiscoveries(providerRecord, discoveries) {
    const incoming = Array.isArray(discoveries) ? discoveries : [];
    const filteredUpstream = discoveries?.policyFiltered === true;
    const admitted = isFreeOnlyProvider(providerRecord)
        ? incoming.filter(isAdmissibleFreeDiscovery)
        : [...incoming];
    return {
        admitted,
        emptyDiscovery: incoming.length === 0 && !filteredUpstream,
        policyFiltered:
            filteredUpstream || (incoming.length > 0 && admitted.length === 0),
    };
}

/**
 * The tombstoned keys a sync must not recreate: those that no row currently
 * holds. A tombstone only keeps a deleted key deleted. Once a row holds that
 * key again — an administrator created one, or renamed an existing row onto
 * it — the row wins; otherwise the sync would skip that discovery and then
 * disable the row for being missing from the catalog.
 *
 * @param {Iterable<string>} tombstonedKeys
 * @param {Array<object>} existingRows rows of the same provider
 * @returns {Set<string>}
 */
export function blockedTombstonedKeys(tombstonedKeys, existingRows) {
    const live = new Set(
        (Array.isArray(existingRows) ? existingRows : []).map(
            (row) => row?.model_key
        )
    );
    const blocked = new Set();
    for (const key of tombstonedKeys || []) {
        if (!live.has(key)) blocked.add(key);
    }
    return blocked;
}

/**
 * Sync result for an empty catalog that left every stored row untouched.
 */
export function emptySkippedSyncResult(existingRows) {
    return {
        discovered: 0,
        created: 0,
        updated: 0,
        disabled: 0,
        emptySkipped: true,
        tagTierModelsAppended: 0,
        tagTierModelsRemoved: 0,
        tagTiersCreated: 0,
        tagTiersUpdated: 0,
        models: existingRows,
    };
}

/**
 * Mark a normalized discovery of a free-only provider that measurement found
 * unfit to serve a fallback, so it never joins an auto tag tier. The mark is
 * recomputed on every sync because a sync replaces the metadata of enabled
 * rows.
 *
 * @param {object} providerRecord normalized provider record
 * @param {object} normalizedDiscovery
 * @returns {object}
 */
export function withTagTierEligibility(providerRecord, normalizedDiscovery) {
    if (
        !isFreeOnlyProvider(providerRecord) ||
        !isTagTierExcludedId(normalizedDiscovery.providerModelId)
    ) {
        return normalizedDiscovery;
    }
    return {
        ...normalizedDiscovery,
        metadata: {
            ...(normalizedDiscovery.metadata || {}),
            [EXCLUDED_FROM_TAG_TIERS_METADATA_KEY]: true,
        },
    };
}

export default {
    admitDiscoveries,
    blockedTombstonedKeys,
    emptySkippedSyncResult,
    isAdmissibleFreeDiscovery,
    withTagTierEligibility,
};
