import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { noWaitRuntimes, resolveExplorerGraphOrSkip } from './explorer-graph.mjs';

const workflow = fs.readFileSync(new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url), 'utf8');
const publicUrl = 'https://explorer-qa.axiologic.dev';
const service = '/base-agent-additional-server/userPersistoAgent/7000/service';
const issuer = `${publicUrl}${service}/oidc`;
function block(name) {
    const match = workflow.match(new RegExp(`// BEGIN QA ${name}\\n([\\s\\S]*?)// END QA ${name}`));
    assert.ok(match);
    return match[1].replace(/^ {10}/gm, '');
}

function configurationFixture(t, { explicit = '', objects, corrupt = false, googleClientId = '' } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-identity-config-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const snapshotFile = path.join(root, '.userpersisto.snapshot.json');
    if (objects) {
        const payload = JSON.stringify({ system: { currentIDNumber: 9 }, ...objects });
        fs.writeFileSync(snapshotFile, JSON.stringify({ version: 1, payload,
            sha256: corrupt ? 'invalid' : crypto.createHash('sha256').update(payload).digest('hex') }));
    }
    const writes = [];
    const source = block('UserPersisto configuration').replace('/home/admin/explorerQaWorkspace/.data/userPersistoAgent/persisto', root);
    return {
        writes,
        run() {
            new Function('assert', 'crypto', 'fs', 'collectManifestEnv', 'handleVarCommand', 'process', source)(
                assert, crypto, fs,
                () => ({ resolved: [
                    { insideName: 'USERPERSISTO_ALLOWED_REDIRECT_ORIGINS', value: explicit },
                    { insideName: 'PERSISTENCE_FOLDER', value: '/data/persisto' },
                ] }),
                args => writes.push(args), { argv: ['node', '-', publicUrl], env: { QA_USERPERSISTO_GOOGLE_CLIENT_ID: googleClientId } },
            );
        },
        snapshot: () => fs.existsSync(snapshotFile) ? fs.readFileSync(snapshotFile, 'utf8') : null,
    };
}

test('QA identity configuration preserves effective environment origins and configures public callback addresses', t => {
    const f = configurationFixture(t, { explicit: ' https://existing.example , ,https://existing.example ', objects: {
        'SETTING.1': { key: 'auth.policy', value: { allowedRedirectOrigins: ['https://overridden.example'] } },
    } });
    const before = f.snapshot();
    f.run();
    assert.deepEqual(f.writes, [
        ['USERPERSISTO_OIDC_ISSUER', issuer],
        ['USERPERSISTO_ALLOWED_REDIRECT_ORIGINS', `https://existing.example,${publicUrl}`],
        ['USERPERSISTO_GOOGLE_REDIRECT_URI', `${publicUrl}${service}/auth/google/callback`],
    ]);
    assert.equal(f.snapshot(), before);
});

test('QA Google callback disables local defaults while a public client override is optional and validated', t => {
    const client = '123-public.apps.googleusercontent.com';
    const configured = configurationFixture(t, { googleClientId: client });
    configured.run();
    assert.deepEqual(configured.writes.at(-1), ['USERPERSISTO_GOOGLE_CLIENT_ID', client]);
    const preserved = configurationFixture(t);
    preserved.run();
    assert.equal(preserved.writes.some(([name]) => name === 'USERPERSISTO_GOOGLE_CLIENT_ID'), false);
    const invalid = configurationFixture(t, { googleClientId: 'unexpected whitespace or secret' });
    assert.throws(() => invalid.run(), /Google Web application client ID/);
    assert.deepEqual(invalid.writes, []);
});

test('QA identity configuration preserves stored origins and owner/setup objects without opening the store', t => {
    const f = configurationFixture(t, { objects: {
        'SETTING.1': { key: 'auth.policy', value: { allowedRedirectOrigins: ['https://existing.example'] } },
        'SETTING.2': { key: 'installation.setup', value: { complete: true, initialAdministratorId: 'USER.1' } },
        'USER.1': { email: 'owner@example.test' },
    } });
    const before = f.snapshot();
    f.run();
    assert.equal(f.writes[1][1], `https://existing.example,${publicUrl}`);
    assert.equal(f.snapshot(), before);
    const fresh = configurationFixture(t);
    fresh.run();
    assert.equal(fresh.writes[1][1], publicUrl);
    assert.equal(fresh.snapshot(), null);
});

test('invalid preserved origin policy fails before any configuration write', t => {
    for (const options of [
        { explicit: 'https://evil.example/path' },
        { objects: {}, corrupt: true },
        { objects: { 'SETTING.1': { key: 'auth.policy', value: { allowedRedirectOrigins: 'not-an-array' } } } },
    ]) {
        const f = configurationFixture(t, options);
        assert.throws(() => f.run());
        assert.deepEqual(f.writes, []);
    }
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function verifyPublic(overrides = {}) {
    const login = `${publicUrl}${service}/auth/?requestId=request&state=state`;
    const responses = {
        [login]: '<main id="auth_content"></main><script type="module" src="main.js"></script>',
        [`${publicUrl}${service}/auth/setup`]: { ok: true, setupComplete: false, registration: true, methods: { password: true, emailCode: true } },
        [`${issuer}/.well-known/openid-configuration`]: {
            issuer, code_challenge_methods_supported: ['S256'], authorization_endpoint: `${issuer}/auth`,
            token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, userinfo_endpoint: `${issuer}/me`,
        },
        ...overrides.responses,
    };
    const requests = [];
    const logs = [];
    await new AsyncFunction('body', 'headers', 'mismatchBody', 'mismatchHeaders', 'fetch', 'process', 'console', block('public email-first verification'))(
        overrides.body || `Continue with Single Sign-On<script>window.location.replace(${JSON.stringify(login)})</script>`,
        'cf-ray: test', { ok: false, error: 'auth_route_context_mismatch' }, 'cf-ray: test',
        async (url, options) => {
            requests.push(url);
            assert.equal(options.redirect, 'error');
            assert.equal(options.method, undefined, 'verification must never submit sign-in or registration');
            assert(Object.hasOwn(responses, url));
            return { ok: true, headers: new Map([['cf-ray', 'test']]), text: async () => responses[url], json: async () => responses[url] };
        },
        { exit: () => { throw new Error('verification rejected'); } },
        { log: (label, details) => logs.push({ label, details: JSON.parse(details) }) },
    );
    return { requests, logs };
}

test('QA public verification checks the SSO wizard and OIDC metadata without claiming an unclaimed installation', async () => {
    const result = await verifyPublic();
    assert.equal(result.requests.length, 3);
    assert.deepEqual(result.logs[0].details.methods, { password: true, emailCode: true, passkey: false, totp: false, google: false });
    await assert.rejects(verifyPublic({ body: '<form data-auth-login-form><input type="password"></form>' }), /rejected/);
    await assert.rejects(verifyPublic({ body: 'Continue with Single Sign-On<script>window.location.replace("https://other.example/auth/?state=x&requestId=y")</script>' }), /rejected/);
    await assert.rejects(verifyPublic({ responses: {
        [`${issuer}/.well-known/openid-configuration`]: { issuer: 'https://other.example' },
    } }), /rejected/);
});

test('QA config executes after durable preservation and before graph activation, without changing other auth settings', () => {
    const configure = workflow.indexOf('// BEGIN QA UserPersisto configuration');
    assert(configure > workflow.indexOf('// END QA durable workspace preservation'));
    assert(configure < workflow.indexOf('"$PLOINKY" start explorer "${BRANCH_ARGS[@]}"'));
    assert.match(block('UserPersisto configuration'), /collectManifestEnv/);
    assert.doesNotMatch(block('UserPersisto configuration'), /USERPERSISTO_DEV_BOOTSTRAP|USERPERSISTO_AUTH_METHODS|USERPERSISTO_SELF_REGISTRATION_ENABLED/);
});

test('QA readiness includes UserPersisto and its email dependency in the default graph baseline', t => {
    const explorer = JSON.parse(fs.readFileSync(new URL('../../../explorer/manifest.json', import.meta.url), 'utf8'));
    const provider = JSON.parse(fs.readFileSync(new URL('../../../userPersistoAgent/manifest.json', import.meta.url), 'utf8'));
    assert.equal(explorer.sso.providerAgent, 'userPersistoAgent');
    assert.ok(explorer.enable.includes('userPersistoAgent'));
    assert.ok(provider.enable.includes('emailAgent'));
    // The workflow's readiness literals are the recursive Explorer graph's totals,
    // and neither the total nor the no-wait count may drift by one either way.
    // The walk needs the sibling checkouts this repository is deployed beside;
    // without them the helper skips the test with an actionable message.
    const graph = resolveExplorerGraphOrSkip(t);
    if (!graph) return;
    const { runtimes } = graph;
    const total = runtimes.size;
    const noWait = noWaitRuntimes(runtimes).length;
    assert.equal(workflow.match(new RegExp(`Tracked agents: ${total}\\b`, 'g'))?.length, 2);
    assert.equal(workflow.match(new RegExp(`Running agents: ${total}\\b`, 'g'))?.length, 2);
    assert.match(workflow, new RegExp(`${total}/${total} process admission and ${noWait}/${noWait} semantic readiness`));
    assert.match(workflow, new RegExp(`EXPECTED_NO_WAIT_AGENTS=${noWait}\\n`));
    for (const wrong of [total - 1, total + 1]) {
        assert.doesNotMatch(workflow, new RegExp(`(?:Tracked|Running) agents: ${wrong}\\b|\\b${wrong}/${wrong} process admission`));
    }
    for (const wrong of [noWait - 1, noWait + 1]) {
        assert.doesNotMatch(workflow, new RegExp(`\\b${wrong}/${wrong} semantic readiness|EXPECTED_NO_WAIT_AGENTS=${wrong}\\n`));
    }
});
