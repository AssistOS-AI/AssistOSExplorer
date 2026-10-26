import assert from 'node:assert/strict';
import test from 'node:test';

import { assertAdministrator } from '../lib/admin.mjs';
import { authInfoFromInvocation } from '../../shared/invocation-auth.mjs';

test('Workspace Monitor tools admit administrators and reject participants', () => {
    assert.doesNotThrow(() => assertAdministrator({ roles: ['admin'] }));
    assert.doesNotThrow(() => assertAdministrator({ user: { roles: ['admin'] }, principalId: 'user:42' }));
    assert.doesNotThrow(() => assertAdministrator({ principalId: 'user:local:admin' }));
    assert.throws(() => assertAdministrator({ roles: ['user'] }), /requires an administrator/);
});

test('a router-signed direct grant whose actor displayName is admin does not make a participant an administrator', () => {
    const authInfo = authInfoFromInvocation({
        iss: 'ploinky-router',
        sub: 'user:USER.3',
        actor: { kind: 'user', id: 'user:USER.3', roles: ['user'], displayName: 'admin' },
        tool: 'workspace_monitor_status'
    });
    assert.equal(authInfo.user.displayName, 'admin');
    assert.throws(() => assertAdministrator(authInfo), /requires an administrator/);
});
