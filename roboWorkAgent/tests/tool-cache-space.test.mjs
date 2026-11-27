import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolCache } from '../server/tool-cache.mjs';
import { OPENCODE_MIGRATION_MIN_FREE_BYTES } from '../server/constants.mjs';

const GIB = 1024 ** 3;
const FLOOR = OPENCODE_MIGRATION_MIN_FREE_BYTES;

async function fixture(t, { version = '2.4.2', free = 100 * GIB } = {}) {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-space-')));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const state = { version, free, calls: [], lines: [], checks: 0 };
    const make = () => new ToolCache({ root: path.join(base, 'tool-cache'), versionPins: {}, log: line => state.lines.push(line),
        fetchImpl: async () => { throw new Error('offline'); },
        freeBytes: async () => { state.checks++; return state.free; },
        execFileImpl: async (command, args) => {
            state.calls.push([command, ...args]);
            if (args[0] === 'view') return { stdout: `"${state.version}"\n`, stderr: '' };
            if (args[0] === 'install' || args.includes('install')) {
                const prefix = args[args.indexOf('--prefix') + 1];
                await fs.mkdir(path.join(prefix, 'bin'), { recursive: true });
                for (const executable of ['opencode', 'codex', 'pi']) await fs.writeFile(path.join(prefix, 'bin', executable), '#!/bin/sh\n', { mode: 0o755 });
                return { stdout: '', stderr: '' };
            }
            if (command.endsWith('/bin/opencode') && args[0] === '--version') return { stdout: `${state.version}\n`, stderr: '' };
            throw new Error(`unexpected command ${command} ${args.join(' ')}`);
        } });
    return { base, state, make, installs: () => state.calls.filter(call => call.includes('install')).length };
}

test('an installation below the floor is refused with its reason and installs nothing', async t => {
    const f = await fixture(t, { free: FLOOR - 1 });
    const cache = f.make();
    await assert.rejects(cache.prepareCodingAgent('opencode'), error => {
        assert.equal(error.code, 'INSUFFICIENT_SPACE');
        assert.equal(error.neededBytes, FLOOR);
        assert.equal(error.freeBytes, FLOOR - 1);
        assert.match(error.message, /not enough free space to install opencode/u);
        return true;
    });
    assert.equal(f.installs(), 0);
    assert.deepEqual(await fs.readdir(path.join(f.base, 'tool-cache/opencode/staging')).catch(() => []), [], 'no staging directory is left');
});

test('exactly at the floor it installs', async t => {
    const f = await fixture(t, { free: FLOOR });
    assert.equal((await f.make().prepareCodingAgent('opencode')).versions.opencode, '2.4.2');
    assert.equal(f.installs(), 1);
});

test('a usable generation at the selected version is reused at 1.5 GiB free and the disk is never looked at', async t => {
    const f = await fixture(t);
    await f.make().prepareCodingAgent('opencode');
    assert.equal(f.installs(), 1);
    f.state.free = 1.5 * GIB;
    f.state.checks = 0;
    const again = await f.make().prepareCodingAgent('opencode');
    assert.equal(again.fallback, undefined);
    assert.equal(f.installs(), 1, 'nothing was installed');
    assert.equal(f.state.checks, 0, 'the floor was not consulted');
});

test('a newer release that needs an installation below the floor falls back to the usable generation without installing it', async t => {
    const f = await fixture(t);
    await f.make().prepareCodingAgent('opencode');
    f.state.version = '2.5.0';
    f.state.free = 1.5 * GIB;
    const result = await f.make().prepareCodingAgent('opencode');
    assert.equal(result.fallback, true);
    assert.equal(result.versions.opencode, '2.4.2');
    assert.equal(f.installs(), 1);
    assert.ok(f.state.lines.some(line => /opencode update unavailable \(not enough free space/u.test(line)), f.state.lines.join('\n'));
});

test('startup warmup below the floor installs no coding agent and says why', async t => {
    const f = await fixture(t, { free: FLOOR - 1 });
    const cache = f.make();
    await cache.warmup();
    const agentInstalls = f.state.calls.filter(call => call.includes('install') && call.some(argument => /^(?:@opencode\/cli|@openai\/codex|@earendil-works|@oh-my-pi|@anthropic-ai|bun)/u.test(argument)));
    assert.deepEqual(agentInstalls, [], 'no coding agent installation was attempted');
    assert.ok(f.state.lines.some(line => line.startsWith('[tool-cache] startup shell preparation failed:')), f.state.lines.join('\n'));
    // Whatever else failed in the shell family (the stub has no network for the other agents), OpenCode's own refusal names the space.
    await assert.rejects(cache.prepareCodingAgent('opencode'), { code: 'INSUFFICIENT_SPACE' });
});

test('only coding agents are subject to the floor', async t => {
    const f = await fixture(t, { free: 0 });
    await assert.rejects(f.make().prepareMode('browser'), error => error.code !== 'INSUFFICIENT_SPACE');
});
