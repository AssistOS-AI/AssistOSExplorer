import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    admitDiscoveries,
    blockedTombstonedKeys,
    isAdmissibleFreeDiscovery,
    withTagTierEligibility,
} from '../../runtime/providers/discovery-admission.mjs';
import {
    FREE_MODEL_EXECUTION_POLICY,
    withFreeOnlyExecutionDefaults,
} from '../../runtime/providers/free-model-policy.mjs';
import { withChildOverrides } from '../../runtime/execution/model-execution.mjs';

const FREE = { providerKey: 'f', settings: { free_only: true } };
const PLAIN = { providerKey: 'p', settings: {} };

function free(id) {
    return { modelId: id, pricingMode: 'free', isFree: true };
}

function filtered(list) {
    Object.defineProperty(list, 'policyFiltered', { value: true, enumerable: false });
    return list;
}

describe('admitDiscoveries', () => {
    it('treats a plain empty list as uninformative', () => {
        assert.deepEqual(admitDiscoveries(FREE, []), { admitted: [], emptyDiscovery: true, policyFiltered: false });
        assert.equal(admitDiscoveries(PLAIN, []).emptyDiscovery, true);
    });

    it('reads the backend policy mark from the original array', () => {
        const decision = admitDiscoveries(FREE, filtered([]));
        assert.equal(decision.emptyDiscovery, false);
        assert.equal(decision.policyFiltered, true);
    });

    it('treats a list emptied by the free-only gate as policy-filtered', () => {
        const decision = admitDiscoveries(FREE, [{ modelId: 'openai/gpt-5', pricingMode: 'token' }]);
        assert.deepEqual(decision.admitted, []);
        assert.equal(decision.emptyDiscovery, false);
        assert.equal(decision.policyFiltered, true);
    });

    it('admits only general chat models on a free-only provider', () => {
        const ids = [
            'vendor/chat:free',
            'nvidia/nemotron-3.5-content-safety:free',
            'meta/llama-guard-4:free',
            'vendor/text-embed-3:free',
            'openrouter/free',
        ];
        const { admitted } = admitDiscoveries(FREE, ids.map(free));
        assert.deepEqual(admitted.map((d) => d.modelId), ['vendor/chat:free', 'openrouter/free']);
        assert.equal(isAdmissibleFreeDiscovery({ modelId: 'vendor/chat:free', pricingMode: 'token' }), false);
    });

    it('applies no admission filter to an ordinary provider', () => {
        const list = [{ modelId: 'nvidia/nemotron-3.5-content-safety:free' }, { modelId: 'openai/gpt-5' }];
        assert.equal(admitDiscoveries(PLAIN, list).admitted.length, 2);
    });
});

describe('withTagTierEligibility', () => {
    it('marks measured-unfit models only on a free-only provider', () => {
        const lightning = { providerModelId: 'nvidia/nemotron-3.5-lightning:free', metadata: { a: 1 } };
        assert.deepEqual(withTagTierEligibility(FREE, lightning).metadata, { a: 1, excludeFromTagTiers: true });
        assert.equal(withTagTierEligibility(PLAIN, lightning), lightning);
        const other = { providerModelId: 'vendor/chat:free', metadata: {} };
        assert.equal(withTagTierEligibility(FREE, other), other);
    });

    it('matches an excluded identifier whatever its letter case', () => {
        // The approved free identifier form is case-insensitive, so the
        // exclusion has to be too.
        for (const id of [
            'NVIDIA/Nemotron-3.5-Lightning:free',
            'nvidia/NEMOTRON-3.5-LIGHTNING:FREE',
            'OpenRouter/Free',
        ]) {
            const marked = withTagTierEligibility(FREE, { providerModelId: id, metadata: {} });
            assert.equal(marked.metadata.excludeFromTagTiers, true, id);
        }
    });
});

describe('blockedTombstonedKeys', () => {
    it('drops a tombstone whose key a row currently holds', () => {
        const blocked = blockedTombstonedKeys(
            new Set(['f/deleted', 'f/renamed-onto']),
            [{ model_key: 'f/renamed-onto' }, { model_key: 'f/other' }]
        );
        assert.deepEqual([...blocked], ['f/deleted']);
    });

    it('keeps every tombstone when the provider has no rows', () => {
        assert.deepEqual([...blockedTombstonedKeys(new Set(['f/a']), [])], ['f/a']);
        assert.deepEqual([...blockedTombstonedKeys(new Set(['f/a']), null)], ['f/a']);
        assert.deepEqual([...blockedTombstonedKeys(null, [])], []);
    });
});

describe('free-only execution defaults', () => {
    it('fills every field a row does not set, only on a free-only provider', () => {
        assert.deepEqual(withFreeOnlyExecutionDefaults({}, FREE), { ...FREE_MODEL_EXECUTION_POLICY });
        assert.deepEqual(
            withFreeOnlyExecutionDefaults({ firstEventTimeoutMs: 9 }, FREE),
            { ...FREE_MODEL_EXECUTION_POLICY, firstEventTimeoutMs: 9 }
        );
        assert.deepEqual(withFreeOnlyExecutionDefaults({}, PLAIN), {});
        assert.deepEqual(withFreeOnlyExecutionDefaults(null, PLAIN), {});
    });

    it('lets tier child settings win over the defaults', () => {
        const model = { modelKey: 'f/m', retryPolicy: withFreeOnlyExecutionDefaults({}, FREE) };
        const child = withChildOverrides(model, {
            retryPolicy: { firstEventTimeoutMs: 3_500, firstContentTimeoutMs: 3_500 },
        });
        assert.equal(child.retryPolicy.firstEventTimeoutMs, 3_500);
        assert.equal(child.retryPolicy.firstContentTimeoutMs, 3_500);
        assert.equal(child.retryPolicy.maxAttempts, 1);
        assert.equal(child.retryPolicy.cooldownMs, FREE_MODEL_EXECUTION_POLICY.cooldownMs);
    });
});
