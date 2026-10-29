import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ALA_PIN, alaRoot } from './helpers/alaSuite.mjs';
import { removeDirectory, shortTempDirectory } from './helpers/topology.mjs';

// The conformance evidence is for one ALA revision. A checkout at any other revision, or not a git checkout, fails.
function fakeAla(context, commit) {
    const root = shortTempDirectory('rw-ala');
    context.after(() => removeDirectory(root));
    fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, 'tests/provider-conformance.mjs'), 'export {};\n');
    if (commit) {
        const git = (...args) => spawnSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });
        git('init', '-q');
        git('add', '-A');
        git('commit', '-q', '-m', 'fixture');
    }
    return root;
}

async function withRoot(root, body) {
    const saved = process.env.ALA_ROOT;
    process.env.ALA_ROOT = root;
    try { return await body(); } finally { if (saved === undefined) delete process.env.ALA_ROOT; else process.env.ALA_ROOT = saved; }
}

test('an ALA checkout at another revision is refused', async (context) => {
    await withRoot(fakeAla(context, true), () => assert.throws(() => alaRoot(), /not the pin cf2996dc/u));
});

test('a directory that is not a git checkout is refused, not skipped', async (context) => {
    await withRoot(fakeAla(context, false), () => assert.throws(() => alaRoot(), /not the pin/u));
});

test('the default sibling ALA checkout is accepted only at the pinned revision', () => {
    assert.equal(ALA_PIN, 'cf2996dcf22465d5ed408a0e93aec2ca59f1f91b');
    assert.ok(alaRoot().endsWith('AdvancedLanguageAgent'));
});
