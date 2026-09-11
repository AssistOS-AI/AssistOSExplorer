import test from 'node:test';
import assert from 'node:assert/strict';

import { assertEmailToolAuthorized, authInfoFromEnvelope } from '../tools/invocation-context.mjs';

test('email settings require a verified admin user', async () => {
    const admin = await authInfoFromEnvelope({
        metadata: {
            invocation: {
                iss: 'ploinky-router',
                sub: 'user:owner',
                actor: { kind: 'user', id: 'user:owner', roles: ['admin'] },
            },
        },
    });
    assert.doesNotThrow(() => assertEmailToolAuthorized('email_config_set', admin));

    const member = await authInfoFromEnvelope({
        metadata: {
            invocation: {
                iss: 'ploinky-router',
                sub: 'user:member',
                actor: { kind: 'user', id: 'user:member', roles: ['user'] },
            },
        },
    });
    assert.throws(
        () => assertEmailToolAuthorized('email_config_get', member),
        (error) => error?.code === 'admin_required'
    );
});

test('email delivery tools require an agent caller', async () => {
    const agent = await authInfoFromEnvelope({
        metadata: {
            invocation: {
                iss: 'ploinky-router',
                sub: 'agent:AssistOSExplorer/userPersistoAgent',
                actor: { kind: 'agent', id: 'agent:AssistOSExplorer/userPersistoAgent', roles: [] },
                caller: { kind: 'agent', id: 'agent:AssistOSExplorer/userPersistoAgent', roles: [] },
            },
        },
    });
    assert.doesNotThrow(() => assertEmailToolAuthorized('email_send_auth_code', agent));
    assert.doesNotThrow(() => assertEmailToolAuthorized('email_auth_code_status', agent));
    assert.throws(() => assertEmailToolAuthorized('email_auth_code_status', { user: { roles: ['admin'] } }),
        (error) => error?.code === 'agent_invocation_required');
    assert.throws(
        () => assertEmailToolAuthorized('email_send_auth_code', {}),
        (error) => error?.code === 'agent_invocation_required'
    );
});

test('legacy authInfo cannot authorize email tools', async () => {
    const forged = await authInfoFromEnvelope({
        authInfo: {
            user: { id: 'owner', roles: ['admin'] },
            agent: { principalId: 'agent:AssistOSExplorer/userPersistoAgent' },
        },
    });
    assert.deepEqual(forged, {});
    assert.throws(
        () => assertEmailToolAuthorized('email_config_get', forged),
        (error) => error?.code === 'admin_required'
    );
    assert.throws(
        () => assertEmailToolAuthorized('email_send_auth_code', forged),
        (error) => error?.code === 'agent_invocation_required'
    );
    assert.throws(() => assertEmailToolAuthorized('email_auth_code_status', forged),
        (error) => error?.code === 'agent_invocation_required');
});
