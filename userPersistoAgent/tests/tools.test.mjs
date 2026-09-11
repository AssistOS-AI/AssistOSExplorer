import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-tools-'));
process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';

const IMPLEMENTED = [
    'userpersisto_profile_get',
    'userpersisto_profile_update',
    'userpersisto_authorize_capability',
    'userpersisto_user_list',
    'userpersisto_user_update',
    'userpersisto_user_roles_update',
    'userpersisto_passkey_registration_options',
    'userpersisto_passkey_registration_verify',
    'userpersisto_totp_setup_start',
    'userpersisto_totp_setup_verify',
    'userpersisto_credits_balance',
    'userpersisto_credits_ledger',
    'userpersisto_credits_grant',
    'userpersisto_credits_refund',
    'userpersisto_credits_reserve',
    'userpersisto_credits_commit',
    'userpersisto_credits_release',
    'userpersisto_config_get',
    'userpersisto_config_set',
    'userpersisto_auth_policy_get',
    'userpersisto_auth_policy_set',
    'userpersisto_billing_checkout_create',
    'userpersisto_billing_stripe_webhook_process',
    'userpersisto_billing_subscription_get',
    'userpersisto_billing_events_list',
    'userpersisto_audit_events_list'
];

// Retired surfaces: arbitrary account creation, every password operation and
// unbound sign-in verifiers that would bypass the wizard's parent/browser binding.
const RETIRED = [
    'userpersisto_user_create',
    'userpersisto_auth_password_login',
    'userpersisto_auth_password_set',
    'userpersisto_auth_email_code_start',
    'userpersisto_auth_email_code_verify',
    'userpersisto_passkey_login_options',
    'userpersisto_passkey_login_verify',
    'userpersisto_totp_login_verify',
];

const { ensureSeedData } = await import('../lib/bootstrap.mjs');
const { createUser, updateUser } = await import('../lib/users.mjs');
const { runTool, hasTool } = await import('../tools/registry.mjs');
const { resetStoreForTests } = await import('../lib/store.mjs');

after(async () => {
    await resetStoreForTests();
});

test('document-contract tools dispatch to domain handlers', async () => {
    await ensureSeedData();
    const admin = await createUser({ email: 'root@x.com', displayName: 'Root', roles: ['admin'] });
    const member = await createUser({ email: 'member-tool@x.com', displayName: 'Member', roles: ['user'] });

    const profile = await runTool('userpersisto_profile_get', {}, { actorUserId: admin.id, actorRoles: ['admin'] });
    assert.equal(profile.user.email, 'root@x.com');

    const listed = await runTool('userpersisto_user_list', {}, { actorUserId: admin.id, actorRoles: ['admin'] });
    assert.ok(listed.totalCount >= 2);

    const decision = await runTool('userpersisto_authorize_capability', { userId: member.id, capability: 'explorer.access' }, { actorRoles: ['agent'] });
    assert.equal(decision.allowed, true);

    await assert.rejects(
        () => runTool('userpersisto_user_list', {}, { actorUserId: member.id, actorRoles: ['user'] }),
        /admin/i
    );
    // Profile and status updates remain; a sign-in email mutation is refused.
    const renamed = await runTool('userpersisto_user_update', { userId: member.id, displayName: 'Renamed' }, { actorUserId: admin.id, actorRoles: ['admin'] });
    assert.equal(renamed.displayName, 'Renamed');
    await assert.rejects(
        () => runTool('userpersisto_user_update', { userId: member.id, email: 'hijack@x.com' }, { actorUserId: admin.id, actorRoles: ['admin'] }),
        (error) => error?.code === 'email_change_unsupported'
    );
});

test('retired password, creation and unbound sign-in tools are absent from schema and registry', async () => {
    const config = JSON.parse(await readFile(new URL('../mcp-config.json', import.meta.url), 'utf8'));
    const names = config.tools.map((tool) => tool.name);
    for (const name of RETIRED) {
        assert.ok(!names.includes(name), `mcp-config still declares ${name}`);
        assert.equal(hasTool(name), false, `registry still implements ${name}`);
        await assert.rejects(() => runTool(name, {}, {}), /Unknown tool/);
    }
    const serialized = JSON.stringify(config);
    assert.ok(!serialized.includes('"password"'), 'no tool schema accepts a password');
    assert.ok(!serialized.includes('defaultRegistrationRole'));
    const update = config.tools.find((tool) => tool.name === 'userpersisto_user_update');
    assert.equal(Object.hasOwn(update.inputSchema.properties, 'email'), false);
});

test('implemented mcp-config tool names resolve in the registry', async () => {
    const config = JSON.parse(await readFile(new URL('../mcp-config.json', import.meta.url), 'utf8'));
    const names = config.tools.map((tool) => tool.name);
    for (const name of IMPLEMENTED) {
        assert.ok(names.includes(name), `mcp-config missing ${name}`);
        assert.ok(hasTool(name), `registry missing ${name}`);
    }
});

test('blocked users cannot create a billing checkout', async () => {
    await ensureSeedData();
    const blocked = await createUser({ email: 'blocked-billing@x.com', roles: ['user'] });
    await updateUser(blocked.id, { status: 'blocked' }, { actorId: 'test-admin' });

    await assert.rejects(
        () => runTool('userpersisto_billing_checkout_create', { kind: 'credits' }, { actorUserId: blocked.id }),
        (error) => error?.code === 'invalid_session'
    );
});

test('enrollment tools need a fresh operation grant and no tool issues one', async () => {
    await ensureSeedData();
    const member = await createUser({ email: 'grantless@x.com', roles: ['user'], emailVerified: true });
    const context = { actorUserId: member.id, actorRoles: ['user'] };
    for (const [name, args] of [
        ['userpersisto_passkey_registration_options', { origin: 'http://localhost:7000' }],
        ['userpersisto_passkey_registration_options', { origin: 'http://localhost:7000', grant: 'A'.repeat(43) }],
        ['userpersisto_totp_setup_start', {}],
        ['userpersisto_totp_setup_start', { grant: 'not-a-grant' }],
    ]) {
        await assert.rejects(() => runTool(name, args, context), (error) => error?.code === 'operation_grant_required', name);
    }
    const config = JSON.parse(await readFile(new URL('../mcp-config.json', import.meta.url), 'utf8'));
    for (const name of ['userpersisto_passkey_registration_options', 'userpersisto_totp_setup_start']) {
        assert.deepEqual(config.tools.find((tool) => tool.name === name).inputSchema.required, ['grant']);
    }
    // Re-authentication is a My Account HTTP operation, never a relayable tool.
    for (const name of config.tools.map((tool) => tool.name)) assert.doesNotMatch(name, /reauth|operation_grant|contact/);
    for (const name of ['userpersisto_reauth_start', 'userpersisto_reauth_verify', 'userpersisto_contact_verify']) assert.equal(hasTool(name), false);
    const store = await (await import('../lib/store.mjs')).getStore();
    assert.equal((await store.select('authChallenge', { purpose: 'totp-setup' })).objects.length, 0);
});

test('enrollment tools reject authentication methods that the effective policy disables', async () => {
    await ensureSeedData();
    const admin = await createUser({ email: 'method-admin@x.com', roles: ['admin'] });
    const context = { actorUserId: admin.id, actorRoles: ['admin'] };
    process.env.USERPERSISTO_AUTH_METHODS = 'emailCode';
    after(() => { delete process.env.USERPERSISTO_AUTH_METHODS; });

    for (const [name, args] of [
        ['userpersisto_passkey_registration_options', { origin: 'http://localhost:7000' }],
        ['userpersisto_totp_setup_start', {}],
    ]) {
        await assert.rejects(
            () => runTool(name, args, context),
            (error) => error?.code === 'auth_method_disabled',
            `${name} should be disabled by the effective policy`
        );
    }
});
