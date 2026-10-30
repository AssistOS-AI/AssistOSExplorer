#!/usr/bin/env node
// Runs specs/08-robowork-worker.spec.mjs against a deployed Explorer whose RoboTeam runs on the robo-work worker.
// The administrator sign-in values come from a mode 0600 JSON file ({"primary":{"loginEmail","accountPassword"}}) and
// are passed to Playwright only through its environment; nothing is printed.
//   SMOKE_ROBOWORK_ACCOUNTS  accounts file (default ~/.local/state/ploinky-tests/robowork-r10-e2e/accounts.json)
//   SMOKE_WORKSPACE_ROOT     host path of the deployed workspace (default ~/work/testExplorerFresh)
//   GATE=1                   gate run: SMOKE_EXPECT_EXPLORER_COMMIT is required and asserted against the deployed AchillesIDE HEAD
//   SMOKE_ARTIFACT_DIR       leave unset (the default is unique per run); an explicit directory must be NEW for every run, because the
//                            acceptance reporter writes its ledger with the `wx` flag and otherwise forces a non-zero exit even for a green run
//   SMOKE_ROBOWORK_EVIDENCE  evidence directory (default <artifact dir>/robowork)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const smokeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const accountsPath = process.env.SMOKE_ROBOWORK_ACCOUNTS
  || path.join(os.homedir(), '.local/state/ploinky-tests/robowork-r10-e2e/accounts.json');
const stat = fs.statSync(accountsPath);
if ((stat.mode & 0o077) !== 0) throw new Error('The accounts file must not be accessible to group or others (mode 0600).');
const { primary } = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
const env = {
  ...process.env,
  SMOKE_ROBOWORK: '1',
  SMOKE_BASE_URL: process.env.SMOKE_BASE_URL || 'http://localhost:8080',
  SMOKE_WORKSPACE_ROOT: process.env.SMOKE_WORKSPACE_ROOT || path.join(os.homedir(), 'work/testExplorerFresh'),
  SMOKE_LOGIN_EMAIL: primary.loginEmail,
  SMOKE_USERNAME: primary.username || primary.loginEmail,
  SMOKE_SIGN_IN_METHOD: 'password',
  SMOKE_ACCOUNT_PASSWORD: primary.accountPassword,
  PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE || 'ubuntu24.04-x64',
};
// Gate runs (GATE=1) must name the candidate: the spec then asserts the deployed AchillesIDE HEAD against SMOKE_EXPECT_EXPLORER_COMMIT.
if (process.env.GATE === '1' && !/^[0-9a-f]{7,40}$/i.test(process.env.SMOKE_EXPECT_EXPLORER_COMMIT || '')) {
  throw new Error('GATE=1 requires SMOKE_EXPECT_EXPLORER_COMMIT (a 7 to 40 digit hexadecimal commit).');
}
const args = process.argv.slice(2);
const child = spawn(process.execPath, [path.join(smokeRoot, 'node_modules/playwright/cli.js'), 'test', '--project=chromium', '--workers=1', '--retries=0',
  ...(args.length ? args : ['specs/08-robowork-worker.spec.mjs'])], { cwd: smokeRoot, env, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
