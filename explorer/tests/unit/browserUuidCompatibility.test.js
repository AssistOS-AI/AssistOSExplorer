import test from 'node:test';
import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';

import { generateId } from '../../services/document/idUtils.js';
import {
    createScriptaDocumentModel,
    mutateScriptaDocument,
    normalizeScriptaDocumentModel,
} from '../../shared/document/scripta-document.js';
import {
    createScriptaVariantId,
    createScriptaVariantImageId,
    normalizeScriptaState,
} from '../../shared/document/scripta-state.js';
import { FileExp } from '../../web-components/pages/file-exp/file-exp.js';

const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

function replaceGlobal(t, name, value) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
    });
}

function useLanCrypto(t) {
    const cryptoApi = {
        calls: 0,
        getRandomValues(bytes) {
            this.calls += 1;
            return randomFillSync(bytes);
        },
    };
    replaceGlobal(t, 'crypto', cryptoApi);
    t.mock.method(Math, 'random', () => {
        throw new Error('Browser identifiers must use cryptographic randomness.');
    });
    return cryptoApi;
}

function useDpuClient(t, callTool) {
    replaceGlobal(t, 'window', {
        webSkel: {
            appServices: {
                getClient: () => ({ callTool }),
            },
        },
    });
}

function assertUuid(value, prefix) {
    assert.match(value, new RegExp(`^${prefix}${UUID_V4}$`));
}

test('document and variant ID utilities keep their prefixes on HTTP LAN browser crypto', (t) => {
    const cryptoApi = useLanCrypto(t);

    assertUuid(generateId(), 'id-');
    assertUuid(generateId('paragraph'), 'paragraph-');
    assertUuid(createScriptaVariantId(), 'variant-');
    assertUuid(createScriptaVariantImageId(), 'variant-image-');
    assert.equal(cryptoApi.calls, 4);
});

test('SCRIPTA creates document, structural and image IDs with getRandomValues only', (t) => {
    const cryptoApi = useLanCrypto(t);
    const document = createScriptaDocumentModel({ title: 'LAN document', createdBy: 'owner' });
    const chapter = document.chapters[0];
    const paragraph = chapter.paragraphs[0];

    assertUuid(document.id, 'document-');
    assert.equal(document.documentId, document.id);
    assert.equal(document.metadata.id, document.id);
    assertUuid(chapter.id, 'chapter-');
    assertUuid(paragraph.id, 'paragraph-');
    assertUuid(paragraph.pluginState.scripta.variants[0].id, 'variant-');

    const changed = mutateScriptaDocument(document, 'paragraph-add', {
        chapterId: chapter.id,
        text: 'Image paragraph',
        assetId: 'asset_lan',
        workspaceUrl: '/WebMeet/lan-room/assets/asset_lan/image.png',
    }, { hash: 'owner' }).document;
    const added = changed.chapters[0].paragraphs[1];
    assertUuid(added.id, 'paragraph-');
    assertUuid(added.pluginState.scripta.variants[0].id, 'variant-');
    assertUuid(added.pluginState.scripta.variants[0].images[0].imageId, 'variant-image-');

    const generatedCount = cryptoApi.calls;
    const normalized = normalizeScriptaDocumentModel(changed);
    assert.equal(normalized.id, changed.id);
    assert.equal(normalized.chapters[0].id, chapter.id);
    assert.deepEqual(normalized.chapters[0].paragraphs.map((entry) => entry.id), [paragraph.id, added.id]);
    assert.deepEqual(normalized.chapters[0].paragraphs[1].pluginState, added.pluginState);
    assert.equal(cryptoApi.calls, generatedCount, 'normalization must retain all persisted IDs');
});

test('SCRIPTA fills missing variant and image IDs while preserving supplied IDs', (t) => {
    const cryptoApi = useLanCrypto(t);
    const image = { assetId: 'asset_lan', workspaceUrl: '/WebMeet/lan-room/assets/asset_lan/image.png' };
    const paragraph = {
        text: 'Existing text',
        metadata: {},
        pluginState: {
            scripta: {
                activeVariantId: 'variant-stored',
                variants: [
                    { id: 'variant-stored', text: 'Existing text', images: [{ ...image, imageId: 'image-stored' }] },
                    { text: 'Imported text', images: [image] },
                ],
            },
        },
    };

    const state = normalizeScriptaState(paragraph);

    assert.equal(state.activeVariantId, 'variant-stored');
    assert.equal(state.variants[0].id, 'variant-stored');
    assert.equal(state.variants[0].images[0].imageId, 'image-stored');
    assertUuid(state.variants[1].id, 'variant-');
    assertUuid(state.variants[1].images[0].imageId, 'variant-image-');
    assert.equal(cryptoApi.calls, 2);
    assert.deepEqual(normalizeScriptaState(paragraph), state);
    assert.equal(cryptoApi.calls, 2);
});

test('DPU acquisition retains the generated idempotency key across failed LAN retries', async (t) => {
    const cryptoApi = useLanCrypto(t);
    const calls = [];
    const statuses = [];
    useDpuClient(t, async (name, args) => {
        calls.push({ name, args });
        throw new Error('Temporary DPU connection failure');
    });
    const context = {
        state: { dpuResearchIdempotencyKey: '' },
        showStatus: (message, isError) => statuses.push({ message, isError }),
    };

    await FileExp.prototype.acquireDpuResearchResource.call(context, null, 'resource-lan');
    await FileExp.prototype.acquireDpuResearchResource.call(context, null, 'resource-lan');

    assert.equal(calls.length, 2);
    assert.equal(calls[0].name, 'dpu_resource_acquire');
    assert.equal(calls[0].args.id, 'resource-lan');
    assertUuid(calls[0].args.idempotencyKey, 'explorer:resource-lan:');
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(context.state.dpuResearchIdempotencyKey, calls[0].args.idempotencyKey);
    assert.equal(cryptoApi.calls, 1);
    assert.equal(statuses.at(-1).message, 'Temporary DPU connection failure');
    assert.equal(statuses.at(-1).isError, true);

    context.state.dpuResearchIdempotencyKey = 'persisted-acquisition-key';
    await FileExp.prototype.acquireDpuResearchResource.call(context, null, 'resource-lan');
    assert.equal(calls[2].args.idempotencyKey, 'persisted-acquisition-key');
    assert.equal(cryptoApi.calls, 1);
});

test('DPU federated and secure proposals use prefixed cryptographic UUIDs on HTTP LAN', async (t) => {
    const cryptoApi = useLanCrypto(t);
    const calls = [];
    const proposals = [];
    const statuses = [];
    useDpuClient(t, async (name, args) => {
        calls.push({ name, args });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, proposal: { id: name } }) }] };
    });
    const answers = ['resource-a,resource-b,resource-c', 'template-lan', 'model-lan', '1', 'fedavg', '3', 'workload-lan'];
    replaceGlobal(t, 'prompt', () => answers.shift());
    const context = {
        state: { dpuResearchResourceId: 'resource-a' },
        confirmDpuActionProposal: async (proposal) => proposals.push(proposal),
        showStatus: (message, isError) => statuses.push({ message, isError }),
    };
    const target = { dataset: { backendId: 'backend-lan' } };

    await FileExp.prototype.runDpuFederatedExperiment.call(context, target);
    await FileExp.prototype.runDpuSecureExecution.call(context, target);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].name, 'dpu_federated_experiment_propose');
    assertUuid(calls[0].args.idempotencyKey, 'explorer:federated:');
    assert.deepEqual(calls[0].args.participantResourceIds, ['resource-a', 'resource-b', 'resource-c']);
    assert.equal(calls[1].name, 'dpu_secure_execution_propose');
    assertUuid(calls[1].args.idempotencyKey, 'explorer:secure:');
    assert.equal(calls[1].args.workloadId, 'workload-lan');
    assert.deepEqual(calls[1].args.resourceIds, ['resource-a']);
    assert.deepEqual(proposals.map(({ id }) => id), calls.map(({ name }) => name));
    assert.equal(statuses.some(({ isError }) => isError), false);
    assert.equal(cryptoApi.calls, 2);
});

test('ID creation fails before sending a DPU mutation when browser crypto is unavailable', async (t) => {
    replaceGlobal(t, 'crypto', undefined);
    t.mock.method(Math, 'random', () => {
        assert.fail('Missing browser crypto must not fall back to Math.random.');
    });
    assert.throws(() => generateId());
    assert.throws(() => createScriptaVariantId());
    assert.throws(() => createScriptaVariantImageId());
    assert.throws(() => createScriptaDocumentModel({ createdBy: 'owner' }));
    const calls = [];
    const statuses = [];
    useDpuClient(t, async (...args) => calls.push(args));
    const context = {
        state: { dpuResearchIdempotencyKey: '' },
        showStatus: (message, isError) => statuses.push({ message, isError }),
    };

    await FileExp.prototype.acquireDpuResearchResource.call(context, null, 'resource-lan');

    assert.deepEqual(calls, []);
    assert.equal(context.state.dpuResearchIdempotencyKey, '');
    assert.equal(statuses.at(-1).isError, true);
});
