import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { resetStoreForTests } from '../lib/store.mjs';
import { environmentPolicyOverrides, getAuthPolicy, updateAuthPolicy } from '../lib/policy.mjs';
import { wizardConfiguration } from '../lib/auth/wizardConfig.mjs';
import { createUser } from '../lib/users.mjs';
import { runTool } from '../tools/registry.mjs';
import { resetAuthLimitsForTests } from './helpers/setup.mjs';

const OVERRIDE = 'USERPERSISTO_SIGNUP_EMAIL_VERIFICATION_REQUIRED';
const agentRoot = fileURLToPath(new URL('..', import.meta.url));
let folder, previousEnvironment;

beforeEach(async () => {
    previousEnvironment = { ...process.env };
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-signup-policy-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'signup-policy-fixture-settings';
    for (const name of ['USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_ALLOWED_REDIRECT_ORIGINS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED',
        OVERRIDE, 'USERPERSISTO_DEV_BOOTSTRAP', 'USERPERSISTO_GOOGLE_CLIENT_ID', 'USERPERSISTO_GOOGLE_REDIRECT_URI']) delete process.env[name];
    resetAuthLimitsForTests();
    await ensureSeedData();
});

afterEach(async () => {
    await resetStoreForTests();
    await rm(folder, { recursive: true, force: true });
    for (const name of Object.keys(process.env)) if (!Object.hasOwn(previousEnvironment, name)) delete process.env[name];
    Object.assign(process.env, previousEnvironment);
});

test('signup email verification defaults off and wizard configuration advertises direct signup without delivery', async () => {
    assert.equal((await getAuthPolicy()).signupEmailVerificationRequired, false);
    assert.equal(environmentPolicyOverrides().includes(OVERRIDE), false);
    const withoutDelivery = await wizardConfiguration();
    assert.deepEqual([withoutDelivery.signup.email, withoutDelivery.signup.verification, withoutDelivery.passwordReset], [true, 'none', false]);
    const withDelivery = await wizardConfiguration({ emailAvailable: true });
    assert.deepEqual([withDelivery.signup.email, withDelivery.signup.verification, withDelivery.passwordReset], [true, 'none', true]);
});

test('a stored requirement hides email signup without delivery and restores it with delivery or an explicit false', async () => {
    await updateAuthPolicy({ signupEmailVerificationRequired: true }, { emailStatus: async () => ({ available: true }) });
    assert.equal((await getAuthPolicy()).signupEmailVerificationRequired, true);
    const withoutDelivery = await wizardConfiguration();
    assert.deepEqual([withoutDelivery.signup.email, withoutDelivery.signup.verification], [false, 'required']);
    const withDelivery = await wizardConfiguration({ emailAvailable: true });
    assert.deepEqual([withDelivery.signup.email, withDelivery.signup.verification, withDelivery.passwordReset], [true, 'required', true]);
    await updateAuthPolicy({ signupEmailVerificationRequired: false }, { emailStatus: async () => ({ available: true }) });
    assert.equal((await getAuthPolicy()).signupEmailVerificationRequired, false);
});

test('the environment override wins at read time, is reported, and only exact case-insensitive true enables it', async () => {
    process.env[OVERRIDE] = 'true';
    assert.equal((await getAuthPolicy()).signupEmailVerificationRequired, true);
    assert.deepEqual(environmentPolicyOverrides(), [OVERRIDE]);
    assert.equal((await wizardConfiguration()).signup.verification, 'required');
    process.env[OVERRIDE] = 'TRUE';
    assert.equal((await getAuthPolicy()).signupEmailVerificationRequired, true);
    process.env[OVERRIDE] = '1';
    assert.equal((await getAuthPolicy()).signupEmailVerificationRequired, false);
    delete process.env[OVERRIDE];
    await updateAuthPolicy({ signupEmailVerificationRequired: true }, { emailStatus: async () => ({ available: true }) });
    process.env[OVERRIDE] = 'false';
    assert.equal((await getAuthPolicy()).signupEmailVerificationRequired, false);
    assert.deepEqual(environmentPolicyOverrides(), [OVERRIDE]);
});

test('non-boolean stored values normalize to false instead of guessing', async () => {
    await updateAuthPolicy({ signupEmailVerificationRequired: 'yes' }, { emailStatus: async () => ({ available: true }) });
    assert.equal((await getAuthPolicy()).signupEmailVerificationRequired, false);
});

test('email delivery availability is read-only provenance on the policy tool and refused on write', async () => {
    await assert.rejects(
        () => updateAuthPolicy({ emailDeliveryAvailable: true }, { emailStatus: async () => ({ available: true }) }),
        { code: 'read_only_policy_field' },
    );
    const admin = await createUser({ email: 'policy-admin@example.test', roles: ['admin'], emailVerified: true });
    const context = { actorUserId: admin.id, actorRoles: ['admin'] };
    const unavailable = await runTool('userpersisto_auth_policy_get', {}, context);
    assert.equal(unavailable.emailDeliveryAvailable, false);
    process.env.USERPERSISTO_DEV_BOOTSTRAP = 'true';
    const available = await runTool('userpersisto_auth_policy_get', {}, context);
    assert.equal(available.emailDeliveryAvailable, true);
    assert.equal(available.signupEmailVerificationRequired, false);
});

test('the policy tool schema and manifest declare the new field without exposing a password property', async () => {
    const config = JSON.parse(await readFile(join(agentRoot, 'mcp-config.json'), 'utf8'));
    const policySet = config.tools.find((tool) => tool.name === 'userpersisto_auth_policy_set');
    assert.deepEqual(policySet.inputSchema.properties.signupEmailVerificationRequired, { type: 'boolean' });
    assert.equal(policySet.inputSchema.additionalProperties, false);
    const policyGet = config.tools.find((tool) => tool.name === 'userpersisto_auth_policy_get');
    assert.match(policyGet.description, /email delivery availability/);
    const manifest = JSON.parse(await readFile(join(agentRoot, 'manifest.json'), 'utf8'));
    const profiles = Object.values(manifest.profiles);
    assert.ok(profiles.length > 0);
    for (const profile of profiles) {
        if (Object.hasOwn(profile.env || {}, OVERRIDE)) assert.equal(profile.env[OVERRIDE].required, false);
    }
    assert.ok(profiles.some((profile) => Object.hasOwn(profile.env || {}, OVERRIDE)), 'the override must be declared');
});
