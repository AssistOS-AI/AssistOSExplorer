import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { PODMAN_LIFETIME_SCRIPT } from '../../server/sandbox/podmanRunner.mjs';
import { makeTempDir } from '../helpers/synthetic.mjs';

const alive = (pid) => {
    try { return !['Z', 'X'].includes(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)[0]); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const waitFor = async (predicate) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { assert.ok(Date.now() < deadline, 'owned command processes disappear within 5 seconds'); await new Promise((resolve) => setTimeout(resolve, 10)); }
};

test('fixed Podman lifetime monitor kills the owned command and its child after worker SIGKILL; unrelated child survives', { skip: process.platform !== 'linux' }, async (t) => {
    const dir = makeTempDir(t); const record = path.join(dir, 'pids.json');
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    t.after(() => unrelated.kill('SIGKILL'));
    // Substitute only the executable in the fixed source, leaving the session, pipe and cleanup logic unchanged.
    const script = PODMAN_LIFETIME_SCRIPT.replace('/usr/bin/podman', process.execPath);
    const fakePodman = `const fs=require('node:fs'); const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,child:child.pid})); setInterval(()=>{},1000);`;
    const driver = `const {spawn}=require('node:child_process'); spawn('/bin/sh',['-c',${JSON.stringify(script)},'rw-podman','-e',${JSON.stringify(fakePodman)}],{stdio:['pipe','ignore','ignore']}); setInterval(()=>{},1000);`;
    const worker = spawn(process.execPath, ['-e', driver], { stdio: 'ignore' });
    let owned;
    t.after(() => {
        worker.kill('SIGKILL');
        if (owned && alive(owned.pid)) { try { process.kill(-owned.pid, 'SIGKILL'); } catch { /* already gone */ } }
    });
    await waitFor(() => fs.existsSync(record));
    owned = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.equal(alive(owned.pid), true); assert.equal(alive(owned.child), true);
    worker.kill('SIGKILL');
    await waitFor(() => !alive(owned.pid) && !alive(owned.child));
    assert.equal(alive(unrelated.pid), true, 'cleanup never signals an unrelated group');
});
