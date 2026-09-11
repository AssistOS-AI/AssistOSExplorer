import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('sign-in emails can differ from the expected authenticated usernames for both accounts', async (t) => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-smoke-account-config-'));
  const values = {
    SMOKE_ARTIFACT_DIR: artifactRoot,
    SMOKE_USERNAME: 'owner-account', SMOKE_LOGIN_EMAIL: 'owner@example.test',
    SMOKE_SECONDARY_USERNAME: 'member-account', SMOKE_SECONDARY_LOGIN_EMAIL: 'member@example.test',
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  });
  const { smokeConfig } = await import(`./config.mjs?separate-login=${Date.now()}`);
  assert.equal(smokeConfig.primaryUser.username, 'owner-account');
  assert.equal(smokeConfig.primaryUser.loginEmail, 'owner@example.test');
  assert.equal(smokeConfig.secondaryUser.username, 'member-account');
  assert.equal(smokeConfig.secondaryUser.loginEmail, 'member@example.test');

  delete process.env.SMOKE_LOGIN_EMAIL;
  delete process.env.SMOKE_SECONDARY_LOGIN_EMAIL;
  process.env.SMOKE_USERNAME = 'owner@example.test';
  process.env.SMOKE_SECONDARY_USERNAME = 'member@example.test';
  const { smokeConfig: emailOnly } = await import(`./config.mjs?email-only=${Date.now()}`);
  assert.equal(emailOnly.primaryUser.loginEmail, emailOnly.primaryUser.username);
  assert.equal(emailOnly.secondaryUser.loginEmail, emailOnly.secondaryUser.username);
});

test('UserPersisto sign-in methods default to administrator password and email code with no secret defaults', async (t) => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-smoke-sign-in-config-'));
  const names = ['SMOKE_ARTIFACT_DIR', 'SMOKE_ADMIN_PASSWORD', 'SMOKE_EMAIL_CODE_COMMAND', 'SMOKE_SIGN_IN_METHOD',
    'SMOKE_SECONDARY_SIGN_IN_METHOD', 'SMOKE_TOTP_SECRET', 'SMOKE_SECONDARY_TOTP_SECRET', 'SMOKE_ACCOUNT_EMAIL_DOMAIN'];
  const previous = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  for (const name of names) delete process.env[name];
  process.env.SMOKE_ARTIFACT_DIR = artifactRoot;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  });
  const { smokeConfig } = await import(`./config.mjs?sign-in-defaults=${Date.now()}`);
  assert.equal(smokeConfig.administratorPassword, '');
  assert.equal(smokeConfig.emailCodeCommand, '');
  assert.equal(smokeConfig.primaryUser.signInMethod, 'adminPassword');
  assert.equal(smokeConfig.secondaryUser.signInMethod, 'emailCode');
  assert.equal(smokeConfig.accountEmailDomain, 'example.test');

  Object.assign(process.env, { SMOKE_SIGN_IN_METHOD: 'totp', SMOKE_SECONDARY_SIGN_IN_METHOD: 'password', SMOKE_SECONDARY_TOTP_SECRET: 'JBSWY3DPEHPK3PXP' });
  const { smokeConfig: selected } = await import(`./config.mjs?sign-in-selected=${Date.now()}`);
  assert.equal(selected.primaryUser.signInMethod, 'totp');
  assert.equal(selected.secondaryUser.signInMethod, 'emailCode', 'a retired password method is not a UserPersisto sign-in method');
  assert.equal(selected.secondaryUser.totpSecret, 'JBSWY3DPEHPK3PXP');
});
