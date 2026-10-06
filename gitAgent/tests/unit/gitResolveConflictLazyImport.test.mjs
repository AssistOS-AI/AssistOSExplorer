import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('../../lib/git-resolve-conflict.js', import.meta.url));

test('git-resolve-conflict loads without resolving achillesAgentLib until an LLM is needed', async () => {
    // Copy the module to a directory with no node_modules ancestor so the bare
    // specifier cannot resolve; a static import would fail with ERR_MODULE_NOT_FOUND.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-resolve-lazy-'));
    try {
        const copy = path.join(dir, 'git-resolve-conflict.js');
        await fs.copyFile(sourcePath, copy);
        const script = `
            const mod = await import(${JSON.stringify(copy)});
            if (typeof mod.default !== 'function') process.exit(3);
            const merged = await mod.default({ base: 'a\\nb\\nc\\n', ours: 'A\\nb\\nc\\n', theirs: 'a\\nb\\nC\\n' });
            if (merged !== 'A\\nb\\nC\\n') { console.error('unexpected merge: ' + JSON.stringify(merged)); process.exit(4); }
        `;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('git-resolve-conflict source has no static achillesAgentLib import', async () => {
    const source = await fs.readFile(sourcePath, 'utf8');
    assert.doesNotMatch(source, /^\s*import\s[^;]*from\s+['"]achillesAgentLib/m);
});
