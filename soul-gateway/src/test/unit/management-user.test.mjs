import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    deriveUserKeyOwner,
    managementUserView,
    normalizeOwnerPart,
} from '../../management/management-user.mjs';

describe('management user key owner helpers', () => {
    it('prefers the Ploinky username for the key owner', () => {
        assert.equal(
            deriveUserKeyOwner({
                id: 'local:admin',
                username: 'admin',
                email: 'admin@example.test',
            }),
            'admin',
        );
    });

    it('falls back from a local id to the id suffix', () => {
        assert.equal(deriveUserKeyOwner({ id: 'local:admin' }), 'admin');
    });

    it('sanitizes owner parts to the Soul Gateway owner grammar', () => {
        assert.equal(normalizeOwnerPart('alice@example.test'), 'alice-example.test');
        assert.equal(normalizeOwnerPart(' local:Jane Doe '), 'Jane-Doe');
    });

    it('returns a compact safe current-user view', () => {
        assert.deepEqual(
            managementUserView({
                source: 'router-sso',
                user: {
                    id: 'local:admin',
                    username: 'admin',
                    email: 'admin@example.test',
                    roles: ['admin'],
                    secret: 'hidden',
                },
            }),
            {
                id: 'local:admin',
                username: 'admin',
                email: 'admin@example.test',
                roles: ['admin'],
                keyOwner: 'admin',
            },
        );
    });
});
