import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { startService } from '../service/index.mjs';
import { resetStoreForTests } from '../lib/store.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { createProvider, resolveProviderConfig } from '../runtime/index.mjs';
import { getUserById, getUserRoles } from '../lib/users.mjs';
import { issueAuthCode } from '../lib/sso.mjs';
import { getStore, flush } from '../lib/store.mjs';
import { registerWithEmailCode, resetAuthLimitsForTests } from './helpers/setup.mjs';

test('SSO sends browsers to the public callback origin while provider calls stay private', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-public-login-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'test-public-login-settings';
    process.env.USERPERSISTO_RUNTIME_SECRET = 'test-public-login-runtime';
    process.env.USERPERSISTO_ALLOWED_REDIRECT_ORIGINS = 'https://workspace.example.test';
    let server;
    try {
        await ensureSeedData();
        server = startService({ port: 0, host: '127.0.0.1' });
        if (!server.listening) await once(server, 'listening');
        const privateBase = `http://127.0.0.1:${server.address().port}`;
        const requests = [];
        server.on('request', (req) => requests.push(req.url));
        const config = resolveProviderConfig({
            providerConfig: { routerBaseUrl: privateBase, runtimePath: '/service/runtime' },
            readValue: () => process.env.USERPERSISTO_RUNTIME_SECRET,
        });
        const provider = createProvider({ getConfig: async () => config });
        for (const origin of ['https://workspace.example.test', 'http://localhost:9912']) {
            const started = await provider.sso_begin_login({ redirectUri: `${origin}/auth/callback` });
            const url = new URL(started.authorizationUrl);
            assert.equal(url.origin, origin);
            assert.equal(url.pathname, '/base-agent-additional-server/userPersistoAgent/7000/service/auth/');
            assert.equal(url.searchParams.get('requestId'), started.providerState);
            assert.equal(url.searchParams.get('state'), started.providerState);
            assert.equal(url.searchParams.has('returnTo'), false);
        }
        // The Router's return target is forwarded for the wizard's Start again link
        // only when it is a relative path; the Router revalidates it on use.
        const withReturn = new URL((await provider.sso_begin_login({ redirectUri: 'https://workspace.example.test/auth/callback', returnTo: '/explorer/?path=%2Fdocs' })).authorizationUrl);
        assert.equal(withReturn.searchParams.get('returnTo'), '/explorer/?path=%2Fdocs');
        for (const returnTo of ['//evil.example/', 'https://evil.example/', 'javascript:alert(1)', '/\\evil']) {
            const unsafe = new URL((await provider.sso_begin_login({ redirectUri: 'https://workspace.example.test/auth/callback', returnTo })).authorizationUrl);
            assert.equal(unsafe.searchParams.has('returnTo'), false, returnTo);
        }
        requests.length = 2;
        assert.deepEqual(requests, ['/service/runtime/sso-login-request', '/service/runtime/sso-login-request']);
        assert.equal(config.routerBaseUrl, privateBase);
        await assert.rejects(() => provider.sso_begin_login({ redirectUri: 'javascript:alert(1)' }));
        await assert.rejects(() => provider.sso_begin_login({ redirectUri: 'https://user:password@workspace.example.test/auth/callback' }));
    } finally {
        if (server?.listening) await new Promise((resolve) => server.close(resolve));
        await resetStoreForTests();
        await rm(folder, { recursive: true, force: true });
        delete process.env.USERPERSISTO_ALLOWED_REDIRECT_ORIGINS;
    }
});

test('provider account projections preserve optional fields and an email-only account can be promoted without adding a username', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-optional-username-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'test-optional-username-settings';
    process.env.USERPERSISTO_RUNTIME_SECRET = 'test-optional-username-runtime';
    let server;
    try {
        await ensureSeedData();
        resetAuthLimitsForTests();
        const owner = await registerWithEmailCode('owner@example.test');
        const member = await registerWithEmailCode('member@example.test');
        server = startService({ port: 0, host: '127.0.0.1' });
        if (!server.listening) await once(server, 'listening');
        const provider = createProvider({ getConfig: async () => ({
            routerBaseUrl: `http://127.0.0.1:${server.address().port}`,
            loginPath: '/service/auth/', runtimePath: '/service/runtime',
            runtimeSecret: process.env.USERPERSISTO_RUNTIME_SECRET,
        }) });
        const login = await provider.sso_begin_login({ redirectUri: 'http://localhost:8080/auth/callback' });
        const issued = await issueAuthCode({ providerState: login.providerState, userId: member.user.id });
        const session = await provider.sso_handle_callback({ providerState: login.providerState, query: { code: issued.code } });
        assert.equal(session.user.username, '');
        assert.equal(session.user.email, 'member@example.test');
        assert.equal((await provider.sso_refresh_session(session)).user.username, '');
        assert.equal(session.providerSession.generation, 0);
        await assert.rejects(provider.sso_admin_create_user({ actorUserId: owner.user.id, email: 'new@example.test', roles: ['admin'] }),
            { code: 'user_creation_unsupported' });

        const listed = await provider.sso_admin_list_users({ actorUserId: owner.user.id });
        const row = listed.users.find((user) => user.id === member.user.id);
        assert.equal(row.username, '');
        assert.equal(row.name, '');
        assert.equal(row.displayName, '');
        assert.deepEqual(row.roles, ['selfRegistered']);
        const defaults = await provider.sso_admin_list_users({
            actorUserId: owner.user.id, excludeOnlyRole: 'selfRegistered', includeRoleCounts: true,
        });
        assert.deepEqual(defaults.users.map(user => user.id), [owner.user.id]);
        assert.equal(defaults.totalCount, 1);
        assert.equal(defaults.singleRoleCounts.selfRegistered, 1);
        const searched = await provider.sso_admin_list_users({
            actorUserId: owner.user.id, search: ' MEMBER@EXAMPLE ', includeRoleCounts: true,
        });
        assert.deepEqual(searched.users.map(user => user.id), [member.user.id]);
        assert.equal(searched.singleRoleCounts.selfRegistered, 1);
        await assert.rejects(provider.sso_admin_list_users({
            actorUserId: member.user.id, search: 'owner', includeRoleCounts: true,
        }), error => error.statusCode === 403 || error.code === 'forbidden');
        const updated = await provider.sso_admin_update_user({
            actorUserId: owner.user.id, userId: row.id,
            username: row.username, email: row.email, name: row.name, roles: ['user'],
        });
        assert.equal(updated.username, '');
        assert.equal(updated.name, '');
        assert.deepEqual(updated.roles, ['user']);
        assert.equal((await getUserById(row.id)).username, '');
        assert.equal((await getUserById(row.id)).displayName, '');
        const refreshed = await provider.sso_refresh_session(session);
        assert.equal(refreshed.user.username, '');
        assert.ok(refreshed.user.capabilities.includes('explorer.access'));
        await assert.rejects(provider.sso_admin_update_user({
            actorUserId: owner.user.id, userId: row.id, username: row.email,
        }), (error) => error.code === 'invalid_username');
        assert.deepEqual(await getUserRoles(row.id), ['user']);
        const promoted = await provider.sso_admin_list_users({
            actorUserId: owner.user.id, excludeOnlyRole: 'selfRegistered', includeRoleCounts: true,
        });
        assert.equal(promoted.totalCount, 2);
        assert.equal(promoted.singleRoleCounts.selfRegistered ?? 0, 0);
        // Credential replacement/revocation advances the account generation; the
        // next Router revalidation of the older session is refused.
        await (await getStore()).updateUser(member.user.id, { authGeneration: 1 });
        await flush();
        await assert.rejects(provider.sso_refresh_session(session), (error) => error.code === 'session_revoked' && error.statusCode === 401);
    } finally {
        if (server?.listening) await new Promise((resolve) => server.close(resolve));
        await resetStoreForTests();
        await rm(folder, { recursive: true, force: true });
    }
});
