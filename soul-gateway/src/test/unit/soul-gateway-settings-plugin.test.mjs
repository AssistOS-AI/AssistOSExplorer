import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getApiErrorMessage,
    isWorkspaceDefaultKey,
    normalizeSettingsErrorMessage,
    toDisplayText,
    unwrapDataArray,
} from '../../../IDE-plugins/soul-gateway-settings/soul-gateway-settings.js';

test('Soul Gateway settings plugin renders structured API errors as text', () => {
    assert.equal(
        getApiErrorMessage({
            error: {
                message: 'Forbidden',
                type: 'forbidden',
            },
        }),
        'Forbidden'
    );

    assert.equal(
        getApiErrorMessage({
            error: {
                message: {
                    detail: 'Provider route unavailable',
                },
                type: 'internal_error',
            },
        }),
        'Provider route unavailable'
    );
});

test('Soul Gateway settings plugin never exposes object coercion text', () => {
    assert.equal(toDisplayText('[object Object]', 'Request failed'), 'Request failed');
    assert.equal(toDisplayText(new Error('[object Object]'), 'Request failed'), 'Request failed');
    assert.equal(
        getApiErrorMessage({ error: { type: 'forbidden' } }),
        'forbidden'
    );
});

test('Soul Gateway settings plugin accepts data arrays and keyed data maps', () => {
    assert.deepEqual(unwrapDataArray({ data: ['a', 'b'] }), ['a', 'b']);
    assert.deepEqual(
        unwrapDataArray({
            data: {
                openai: { key: 'openai' },
                anthropic: { key: 'anthropic' },
            },
        }).map((entry) => entry.key),
        ['openai', 'anthropic']
    );
    assert.deepEqual(unwrapDataArray(null), []);
});

test('Soul Gateway settings plugin maps embedded admin auth failures to Explorer wording', () => {
    assert.equal(
        normalizeSettingsErrorMessage('Admin session expired'),
        'Explorer admin session required. Reload Explorer and sign in as an admin.'
    );
    assert.equal(
        getApiErrorMessage({ error: { message: 'Admin session required' } }),
        'Explorer admin session required. Reload Explorer and sign in as an admin.'
    );
});

test('Soul Gateway settings plugin recognizes managed workspace-default keys', () => {
    assert.equal(isWorkspaceDefaultKey({ label: 'workspace-default' }), true);
    assert.equal(isWorkspaceDefaultKey({ metadata: { embedded: true } }), true);
    assert.equal(isWorkspaceDefaultKey({ label: 'user-created' }), false);
});
