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

test('UserPersisto sign-in methods default to email code, accept account passwords and ignore a retired administrator password', async (t) => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-smoke-sign-in-config-'));
  const names = ['SMOKE_ARTIFACT_DIR', 'SMOKE_ADMIN_PASSWORD', 'SMOKE_EMAIL_CODE_COMMAND', 'SMOKE_SIGN_IN_METHOD',
    'SMOKE_SECONDARY_SIGN_IN_METHOD', 'SMOKE_TOTP_SECRET', 'SMOKE_SECONDARY_TOTP_SECRET', 'SMOKE_ACCOUNT_EMAIL_DOMAIN',
    'SMOKE_ACCOUNT_PASSWORD', 'SMOKE_SECONDARY_ACCOUNT_PASSWORD', 'SMOKE_RUN_ACCOUNT_PASSWORD'];
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
  assert.equal(Object.hasOwn(smokeConfig, 'administratorPassword'), false);
  assert.equal(smokeConfig.emailCodeCommand, '');
  assert.equal(smokeConfig.primaryUser.signInMethod, 'emailCode');
  assert.equal(smokeConfig.secondaryUser.signInMethod, 'emailCode');
  assert.deepEqual([smokeConfig.primaryUser.accountPassword, smokeConfig.secondaryUser.accountPassword], ['', '']);
  assert.equal(smokeConfig.accountEmailDomain, 'example.test');
  // One random run password is created in the environment, so workers inherit
  // it and *PASSWORD* redaction covers it.
  assert.match(smokeConfig.runAccountPassword, /^smoke-[A-Za-z0-9_-]{32}$/);
  assert.equal(process.env.SMOKE_RUN_ACCOUNT_PASSWORD === smokeConfig.runAccountPassword, true);

  process.env.SMOKE_ADMIN_PASSWORD = 'retired-must-be-ignored';
  Object.assign(process.env, { SMOKE_SIGN_IN_METHOD: 'totp', SMOKE_SECONDARY_SIGN_IN_METHOD: 'password', SMOKE_SECONDARY_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
    SMOKE_ACCOUNT_PASSWORD: 'fixture primary passphrase', SMOKE_SECONDARY_ACCOUNT_PASSWORD: 'fixture secondary passphrase' });
  const { smokeConfig: selected } = await import(`./config.mjs?sign-in-selected=${Date.now()}`);
  assert.equal(selected.primaryUser.signInMethod, 'totp');
  assert.equal(Object.hasOwn(selected, 'administratorPassword'), false);
  assert.equal(selected.secondaryUser.signInMethod, 'password', 'the account password is a UserPersisto sign-in method');
  assert.equal(selected.primaryUser.accountPassword, 'fixture primary passphrase');
  assert.equal(selected.secondaryUser.accountPassword, 'fixture secondary passphrase');
  assert.equal(selected.primaryUser.password === selected.primaryUser.accountPassword, false, 'the Ploinky form password stays separate');
  assert.equal(selected.runAccountPassword, smokeConfig.runAccountPassword, 'a later import reuses the inherited run password');
  assert.equal(selected.secondaryUser.totpSecret, 'JBSWY3DPEHPK3PXP');
  process.env.SMOKE_SECONDARY_SIGN_IN_METHOD = 'adminPassword';
  const { smokeConfig: retired } = await import(`./config.mjs?sign-in-retired=${Date.now()}`);
  assert.equal(retired.secondaryUser.signInMethod, 'emailCode', 'an unknown method falls back to email code');
});
