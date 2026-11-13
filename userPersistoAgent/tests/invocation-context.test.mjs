import test from 'node:test';
import assert from 'node:assert/strict';

import { actorContext, authInfoFromEnvelope } from '../tools/invocation-context.mjs';

test('tool context is derived from the router-verified invocation grant', async () => {
    const authInfo = await authInfoFromEnvelope({
        metadata: {
            invocation: {
                iss: 'ploinky-router',
                sub: 'user:persisto-user-1',
                actor: { kind: 'user', id: 'user:persisto-user-1', roles: ['admin'] },
                tool: 'userpersisto_profile_get',
            },
        },
    });
    assert.deepEqual(actorContext(authInfo), {
        actorUserId: 'persisto-user-1',
        actorRoles: ['admin'],
    });
});

test('legacy and top-level identity fields are never treated as authority', async () => {
    for (const envelope of [
        { authInfo: { user: { id: 'owner', roles: ['admin'] } } },
        { metadata: { authInfo: { user: { id: 'owner', roles: ['admin'] } } } },
        {
            invocation: {
                iss: 'forged-router',
                sub: 'user:owner',
                actor: { kind: 'user', id: 'user:owner', roles: ['admin'] },
            },
        },
    ]) {
        assert.deepEqual(actorContext(await authInfoFromEnvelope(envelope)), {
            actorUserId: '',
            actorRoles: [],
        });
    }
});

test('service identity is bound to the verified matching caller and actor', async () => {
    const principal = 'agent:ScriptaHubAgent/scriptahubAgent';
    const grant = {
        iss: 'ploinky-router', sub: principal,
        actor: {kind:'agent',id:principal}, caller:{kind:'agent',id:principal},
        tool:'userpersisto_scriptahub_points_apply',
    };
    const derive = async invocation => actorContext(await authInfoFromEnvelope({metadata:{invocation}}));
    assert.equal((await derive(grant)).agentId,principal);
    assert.equal((await derive({...grant,actor:{kind:'user',id:'user:member'}})).agentId,undefined);
    assert.equal((await derive({...grant,caller:{kind:'agent',id:'agent:Other/service'}})).agentId,undefined);
    assert.equal((await derive({...grant,usr:{id:'member'}})).agentId,undefined);
});
