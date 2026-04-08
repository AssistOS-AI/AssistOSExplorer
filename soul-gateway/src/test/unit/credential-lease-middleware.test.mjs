/**
 * credentialLeaseMiddleware tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compose, createKernelContext } from '../../runtime/kernel/index.mjs';
import { credentialLeaseMiddleware } from '../../runtime/execution/credential-lease-middleware.mjs';

function makeCtx({ credentialManager = null } = {}) {
    return createKernelContext({
        requestId: 'req-cred-1',
        target: {
            model: { modelKey: 'm', providerId: 'provider-1' },
        },
        appCtx: {
            services: { credentialManager },
            config: { env: {} },
        },
    });
}

describe('credentialLeaseMiddleware', () => {
    it('passes through when no credentialManager is registered', async () => {
        let calledTerminal = false;
        const ctx = makeCtx();
        await compose([
            credentialLeaseMiddleware(),
            async () => {
                calledTerminal = true;
            },
        ])(ctx);
        assert.ok(calledTerminal);
        assert.equal(ctx.target.credentialLease, undefined);
    });

    it('leases credentials before next() and releases in finally on success', async () => {
        const released = [];
        const cm = {
            async getCredentials(providerId) {
                assert.equal(providerId, 'provider-1');
                return { leaseId: 'lease-1', secret: 'sk-test' };
            },
            release(lease) {
                released.push(lease);
            },
        };
        const ctx = makeCtx({ credentialManager: cm });
        let seenLease = null;
        await compose([
            credentialLeaseMiddleware(),
            async (innerCtx) => {
                seenLease = innerCtx.target.credentialLease;
                assert.equal(seenLease.leaseId, 'lease-1');
                assert.equal(seenLease.secret, 'sk-test');
            },
        ])(ctx);
        assert.equal(released.length, 1);
        assert.equal(released[0].leaseId, 'lease-1');
    });

    it('releases the lease on downstream error', async () => {
        const released = [];
        const cm = {
            async getCredentials() {
                return { leaseId: 'lease-2', secret: 's' };
            },
            release(lease) {
                released.push(lease);
            },
        };
        const ctx = makeCtx({ credentialManager: cm });
        await assert.rejects(
            compose([
                credentialLeaseMiddleware(),
                async () => {
                    throw new Error('boom');
                },
            ])(ctx),
            /boom/
        );
        assert.equal(released.length, 1);
        assert.equal(released[0].leaseId, 'lease-2');
    });

    it('passes through when the model has no providerId', async () => {
        const cm = {
            async getCredentials() {
                throw new Error('should not be called');
            },
            release() {},
        };
        const ctx = createKernelContext({
            requestId: 'r',
            target: { model: { modelKey: 'm' } },
            appCtx: {
                services: { credentialManager: cm },
                config: { env: {} },
            },
        });
        let calledTerminal = false;
        await compose([
            credentialLeaseMiddleware(),
            async () => {
                calledTerminal = true;
            },
        ])(ctx);
        assert.ok(calledTerminal);
    });
});
