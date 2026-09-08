import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const installer = join(packageRoot, 'scripts/installPrerequisites.sh');
const wrapper = join(packageRoot, 'scripts/start-cli.sh');

test('managed MCP readiness declares its private container port', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, '..', 'manifest.json'), 'utf8'));
    assert.equal(manifest.readiness.protocol, 'mcp');
    assert.equal(manifest.cli, 'node /code/server/robot-cli.mjs');
    assert.deepEqual(manifest.containerSecurity, { nestedPodman: true });
});

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'achilles-managed-setup-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bin = join(root, 'bin');
    const home = join(root, 'user-home');
    await mkdir(bin);
    await mkdir(home);
    await writeFile(join(home, 'credentials'), 'untouched');
    const executable = async (name, text) => writeFile(join(bin, name), text, { mode: 0o755 });
    await executable('bwrap', '#!/bin/sh\nexit 0\n');
    await executable('apt-get', '#!/bin/sh\necho "unexpected apt invocation" >&2\nexit 91\n');
    await executable('node', `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (process.env.CAPTURE_WRAPPER) {
    console.log(JSON.stringify({ args, bins: [process.env.CODEX_BIN, process.env.OPENCODE_BIN, process.env.PI_BIN], home: process.env.HOME }));
    process.exit(0);
}
if (process.env.SETUP_NODE_VERSION && args[0] === '-e') {
    args[1] = 'Object.defineProperty(process.versions, "node", { value: ' + JSON.stringify(process.env.SETUP_NODE_VERSION) + ' });\\n' + args[1];
}
const result = spawnSync(${JSON.stringify(process.execPath)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
    const npm = join(root, 'npm-cli.mjs');
    await writeFile(npm, `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
if (!prefix.startsWith(process.env.ACHILLES_NATIVE_PREFIX + path.sep) || !args.includes('--global=false') || !args.includes('--engine-strict=true') || args.includes('-g')) process.exit(92);
if (!process.env.HOME.startsWith(process.env.ACHILLES_NATIVE_PREFIX + path.sep)) process.exit(93);
const spec = args.at(-1);
fs.appendFileSync(process.env.INSTALL_LOG, JSON.stringify({ spec, prefix }) + '\\n');
if (process.env.FAIL_INSTALL) process.exit(94);
const at = spec.lastIndexOf('@');
const packageName = spec.slice(0, at);
const version = spec.slice(at + 1);
const name = path.basename(prefix);
const packageDir = path.join(prefix, 'node_modules', packageName);
fs.mkdirSync(packageDir, { recursive: true });
fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version }));
const binDir = path.join(prefix, 'node_modules', '.bin');
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, name), '#!/bin/sh\\nprintf "%s\\\\n" "' + (name === 'codex' ? 'codex-cli ' : '') + version + '"\\n', { mode: 0o755 });
`);
    const env = {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: home,
        NPM_CLI: npm,
        ACHILLES_NATIVE_PREFIX: join(root, 'native'),
        INSTALL_LOG: join(root, 'installs.jsonl'),
        // Keep fixture execution possible under an older test runner; the separate
        // prerequisite case exercises rejection using the actual installer gate.
        SETUP_NODE_VERSION: '22.19.0',
    };
    return { root, env, run: (overrides = {}) => spawnSync('/bin/sh', [installer], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30000 }) };
}

test('managed setup installs pinned native packages even with bwrap present and reuses verified versions', async (t) => {
    const setup = await fixture(t);
    const first = setup.run();
    assert.equal(first.status, 0, first.stderr);
    const installed = (await readFile(setup.env.INSTALL_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(installed.map(({ spec }) => spec), [
        '@openai/codex@0.139.0', 'opencode-ai@1.15.10', '@earendil-works/pi-coding-agent@0.85.1',
    ]);
    const second = setup.run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal((await readFile(setup.env.INSTALL_LOG, 'utf8')).trim().split('\n').length, 3);
    assert.equal(await readFile(join(setup.env.HOME, 'credentials'), 'utf8'), 'untouched');
    // Matching package metadata alone must not conceal an incompatible executable.
    await writeFile(join(setup.env.ACHILLES_NATIVE_PREFIX, 'pi/node_modules/.bin/pi'), '#!/bin/sh\necho 0.79.4\n');
    const mismatched = setup.run();
    assert.notEqual(mismatched.status, 0);
    assert.match(mismatched.stderr, /executable version verification failed/);
});

test('managed setup rejects an old Node runtime before installation', async (t) => {
    const setup = await fixture(t);
    const result = setup.run({ SETUP_NODE_VERSION: '22.18.0' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Node\.js >=22\.19\.0 is required/);
    await assert.rejects(readFile(setup.env.INSTALL_LOG), { code: 'ENOENT' });
});

test('managed setup reports missing npm and installation failure without proceeding', async (t) => {
    const setup = await fixture(t);
    const missing = setup.run({ NPM_CLI: join(setup.root, 'missing-npm') });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /npm CLI was not found/);
    const failed = setup.run({ FAIL_INSTALL: '1' });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /installation failed/);
    const attempts = (await readFile(setup.env.INSTALL_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(attempts.map(({ spec }) => spec), ['@openai/codex@0.139.0']);
});

test('managed launcher preserves caller binary overrides, argument boundaries, and native home', async (t) => {
    const setup = await fixture(t);
    const args = ['--dir', '/workspace/with spaces', 'literal "quotes" and $HOME', ''];
    const result = spawnSync('/bin/sh', [wrapper, ...args], {
        env: { ...setup.env, CAPTURE_WRAPPER: '1', CODEX_BIN: '/custom codex/bin', PI_BIN: '/custom/pi' },
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const captured = JSON.parse(result.stdout);
    assert.deepEqual(captured.args, ['/code/src/cli.mjs', ...args]);
    assert.deepEqual(captured.bins, ['/custom codex/bin', join(setup.env.ACHILLES_NATIVE_PREFIX, 'opencode/node_modules/.bin/opencode'), '/custom/pi']);
    assert.equal(captured.home, setup.env.HOME);
});

test('managed installer and launcher default to the persistent writable home cache', async (t) => {
    const setup = await fixture(t);
    const env = { ...setup.env, CAPTURE_WRAPPER: '1' };
    delete env.ACHILLES_NATIVE_PREFIX;
    const result = spawnSync('/bin/sh', [wrapper], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).bins, ['codex', 'opencode', 'pi'].map(
        (backend) => `/root/.cache/achilles-native/${backend}/node_modules/.bin/${backend}`));
    assert.match(await readFile(installer, 'utf8'), /NATIVE_PREFIX="\$\{ACHILLES_NATIVE_PREFIX:-\/root\/\.cache\/achilles-native\}"/);
});
