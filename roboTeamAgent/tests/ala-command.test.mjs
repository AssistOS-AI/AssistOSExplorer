import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { resolveAlaCommand } from '../server/ala-command.mjs';

test('explicit ALA override remains available', () => {
    assert.equal(resolveAlaCommand('/custom/ala.mjs'), '/custom/ala.mjs');
});

test('npm dependency resolves from the agent, including cache symlinks and preserved symlinks', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-ala-package-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const code = path.join(root, 'code');
    const cache = path.join(root, 'dependency-cache');
    const entry = path.join(cache, 'advanced-language-agent/bin/ala.mjs');
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, '');
    await fs.mkdir(path.join(code, 'server'), { recursive: true });
    await fs.symlink(cache, path.join(code, 'node_modules'));
    const resolver = path.join(code, 'server/ala-command.mjs');
    await fs.copyFile(new URL('../server/ala-command.mjs', import.meta.url), resolver);
    const output = execFileSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main',
        '--input-type=module', '-e',
        `import { resolveAlaCommand } from ${JSON.stringify(pathToFileURL(resolver).href)}; console.log(resolveAlaCommand());`],
    { cwd: root, encoding: 'utf8' });
    assert.equal(output.trim(), entry);
});
