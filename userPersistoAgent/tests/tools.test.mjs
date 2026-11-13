import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-tools-'));
process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';
process.env.USERPERSISTO_SETTINGS_FILE = join(process.env.PERSISTENCE_FOLDER, 'settings.enc.json');

const IMPLEMENTED = [
    'userpersisto_profile_get',
    'userpersisto_profile_update',
    'userpersisto_authorize_capability',
    'userpersisto_user_list',
    'userpersisto_user_update',
    'userpersisto_user_roles_update',
    'userpersisto_roles_list',
    'userpersisto_role_create',
    'userpersisto_role_update',
    'userpersisto_role_delete',
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
    'userpersisto_billing_credits_offer',
    'userpersisto_billing_credit_price_get',
    'userpersisto_billing_credit_price_set',
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

const { ensureExplorerSeedData: ensureSeedData } = await import('./helpers/product-permissions.mjs');
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
    // No schema property at any depth can carry a password; `password` may
    // appear only as a policy method name.
    const propertyNames = (schema) => (!schema || typeof schema !== 'object' ? [] : [
        ...Object.keys(schema.properties || {}),
        ...Object.values(schema).flatMap((value) => (Array.isArray(value) ? value.flatMap(propertyNames) : propertyNames(value))),
    ]);
    for (const tool of config.tools) {
        assert.deepEqual(propertyNames(tool.inputSchema).filter((name) => /pass(word|phrase)/i.test(name)), [], `${tool.name} accepts no password`);
    }
    const policy = config.tools.find((tool) => tool.name === 'userpersisto_auth_policy_set');
    assert.deepEqual(policy.inputSchema.properties.enabledAuthMethods.items.enum, ['password', 'emailCode', 'passkey', 'totp', 'google'],
        'the policy tool can keep every supported method, including password');
    assert.equal(JSON.stringify(policy.inputSchema).split('"password"').length - 1, 1, 'password appears only as a method name');
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

test('ScriptaHub points only accept the service identity, replay debits and refund a verified spend once', async () => {
    const user = await createUser({ email: 'scriptahub-points@x.com', displayName: 'Points', roles: ['user'] });
    const agent = { agentId: process.env.USERPERSISTO_SCRIPTAHUB_AGENT_ID || 'agent:ScriptaHubAgent/scriptahubAgent' };
    const request = { userId: user.id, requestId: '186b7230-6611-4d5a-a21e-8137c1aaf69e', attempt: 1, amount: 4, kind: 'edition' };
    const call = (operation, fields = {}, context = agent) => runTool('userpersisto_scriptahub_points_apply', { ...request, operation, ...fields }, context);
    await assert.rejects(()=>call('debit',{}, {actorUserId:user.id}), /ScriptaHub agent access/);
    assert.deepEqual(await call('debit'), {insufficient:true,missing:4});
    await assert.rejects(()=>call('refund'), /matching debit/);
    await call('reward',{kind:'book-proposal',amount:10});
    assert.equal((await call('reward',{kind:'book-proposal',amount:10})).balance,10);
    assert.equal((await call('debit')).balance,6);
    assert.equal((await call('debit')).balance,6);
    assert.equal((await call('refund')).balance,10);
    assert.equal((await call('refund')).balance,10);
});


test('only a live billing administrator can view or update point pricing without provider credentials', async () => {
    const admin=await createUser({email:'points-pricing-admin@x.com',roles:['admin']});
    const member=await createUser({email:'points-pricing-member@x.com',roles:['user']});
    const offer={unitAmountMinor:500,currency:'EUR'};
    const schema=JSON.parse(await readFile(new URL('../mcp-config.json',import.meta.url),'utf8'));
    for (const name of ['userpersisto_billing_credit_price_get','userpersisto_billing_credit_price_set']) {
        const tool=schema.tools.find(tool=>tool.name===name);
        assert.deepEqual(tool.tags,['authenticated'],'delegated transport admits the verified user; the handler still checks live billing administration');
    }
    for (const name of ['userpersisto_billing_credit_price_get','userpersisto_billing_credit_price_set']) {
        await assert.rejects(()=>runTool(name,offer,{actorUserId:member.id,actorRoles:['admin']}));
        await assert.rejects(()=>runTool(name,offer,{}));
    }
    assert.deepEqual(await runTool('userpersisto_billing_credit_price_set',offer,{actorUserId:admin.id}),{...offer,currency:'eur'});
    const saved=await runTool('userpersisto_billing_credit_price_get',{}, {actorUserId:admin.id});
    assert.deepEqual(saved,{unitAmountMinor:500,currency:'eur'});
    assert.deepEqual(Object.keys(saved).sort(),['currency','unitAmountMinor']);
    await assert.rejects(()=>runTool('userpersisto_billing_credit_price_set',{...offer,unitAmountMinor:0},{actorUserId:admin.id}));
    assert.deepEqual(await runTool('userpersisto_billing_credit_price_get',{}, {actorUserId:admin.id}),saved);
});


test('payment reconciliation requires live billing administration before contacting Stripe', async t => {
    const member = await createUser({ email: 'reconcile-member@x.com', roles: ['user'] });
    t.mock.method(globalThis, 'fetch', () => assert.fail('Unauthorised reconciliation must not contact Stripe'));
    for (const context of [{}, { actorUserId: member.id, actorRoles: ['admin'] }]) {
        await assert.rejects(() => runTool('userpersisto_billing_checkout_reconcile', { eventId: 'evt_existing' }, context));
    }
});


test('checkout verification requires the active actor and ignores caller-supplied recipient claims',async t=>{
    const member=await createUser({email:'verify-owner@x.com',roles:['user']});
    t.mock.method(globalThis,'fetch',()=>assert.fail('Missing or unowned checkout must not contact Stripe'));
    await assert.rejects(()=>runTool('userpersisto_billing_checkout_verify',{sessionId:'cs_test_unknown'},{}));
    await assert.rejects(()=>runTool('userpersisto_billing_checkout_verify',{sessionId:'cs_test_unknown',userId:'another'},{actorUserId:member.id}),{code:'checkout_not_found'});
});
