import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TRIM = fileURLToPath(new URL('../../server/sandbox/fdTrim.mjs', import.meta.url));
const SCRIPT = `
import fs from 'node:fs';
const open = [];
for (const name of fs.readdirSync('/proc/self/fd')) {
    const n = Number(name);
    let link;
    try { link = fs.readlinkSync('/proc/self/fd/' + n); } catch { continue; }
    if (n >= 3 && link.endsWith('/f.txt')) open.push(n);
}
await new Promise((r) => setTimeout(r, 5));
await fs.promises.readFile(process.argv[1]);
console.log(JSON.stringify({ open, allow: process.env.RW_FD_ALLOW ?? null }));
`;

function run(allow, extra) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-trim-'));
    try {
        const file = path.join(dir, 'f.txt');
        fs.writeFileSync(file, 'x');
        const script = path.join(dir, 's.mjs');
        fs.writeFileSync(script, SCRIPT);
        const env = { ...process.env };
        if (allow !== null) env.RW_FD_ALLOW = allow; else delete env.RW_FD_ALLOW;
        const stdio = ['ignore', 'pipe', 'pipe'];
        const opened = extra.map(() => fs.openSync(file, 'r'));
        for (const fd of opened) stdio.push(fd);
        const result = spawnSync(process.execPath, ['--import', TRIM, script, file], { env, stdio });
        for (const fd of opened) fs.closeSync(fd);
        return result;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('closes inherited fds not in the allowlist, keeps allowed ones, node keeps working, env var removed', () => {
    const result = run('0,1,2,3', [1, 2, 3]); // child fds 3, 4, 5, 6 -> stdio[3..5]
    assert.equal(result.status, 0, String(result.stderr));
    const out = JSON.parse(String(result.stdout));
    assert.deepEqual(out.open, [3]);
    assert.equal(out.allow, null);
});

test('missing or malformed allowlist fails closed', () => {
    assert.notEqual(run(null, []).status, 0);
    assert.notEqual(run('3;x', []).status, 0);
});
