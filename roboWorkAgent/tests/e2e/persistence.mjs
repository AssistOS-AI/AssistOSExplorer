import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { argumentsFrom, SENTINEL } from './isolation.mjs';

// Run inside the robot before and after each operator-owned lifecycle action.
// This command never restarts a container or claims a lifecycle action occurred.
export function checkPersistence({ robot, marker, sha256, stage }, io = fs) {
    assert.match(robot || '', /^[a-z0-9][a-z0-9-]{2,63}$/u);
    assert.ok(['initial', 'restart', 'recreate', 'box-recreate'].includes(stage));
    assert.equal(path.posix.dirname(marker || ''), `/home/${robot}`);
    assert.match(sha256 || '', /^[a-f0-9]{64}$/u);
    const before = io.lstatSync(marker);
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= 4096);
    const descriptor = io.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes;
    try {
        const opened = io.fstatSync(descriptor);
        assert.equal(opened.ino, before.ino); assert.equal(opened.dev, before.dev);
        bytes = io.readFileSync(descriptor);
        const after = io.fstatSync(descriptor);
        for (const key of ['ino', 'dev', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], opened[key]);
    } finally { io.closeSync(descriptor); }
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, 'Persistent robot marker changed or disappeared.');
    return { sentinel: SENTINEL, probe: 'persistence', stage, robot, sha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try { process.stdout.write(JSON.stringify(checkPersistence(argumentsFrom(process.argv.slice(2)))) + '\n'); }
    catch (error) { console.error(`RoboWork persistence probe failed: ${error.message}`); process.exitCode = 1; }
}
