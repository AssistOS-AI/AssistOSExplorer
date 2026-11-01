import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readLiveSkillsHomeBinding } from './copilot-live-skills-runtime.mjs';

function fixture(t) {
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live home ü ')));
    t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
    const robotId = 'owned-live-robot', robotName = 'owned robot', root = `${dataRoot}/robots/${robotId}`, home = `${root}/home`;
    fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(`${root}/label`, JSON.stringify({ id: robotId, name: robotName, codingAgents: ['codex'] }));
    const descriptors = new Map();
    const fsApi = { ...fs,
        openSync(file, flags) { const fd = fs.openSync(file, flags); descriptors.set(fd, file); return fd; },
        closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd); },
        realpathSync(file) {
            if (process.platform !== 'linux' && /^\/proc\/self\/fd\/\d+$/.test(file)) return fs.realpathSync(descriptors.get(Number(path.basename(file))));
            return fs.realpathSync(file);
        },
    };
    const read = async (args = {}) => { let result; try { await readLiveSkillsHomeBinding({ robotId, robotName, ...args },
        { dataRoot, fsApi, emit: value => { result = value; } }); return result; }
    finally { assert.equal(descriptors.size, 0); } };
    return { root, home, dataRoot, robotId, robotName, fsApi, read };
}

test('RoboWork private home observation binds the registered owner and exact home directory object without exposing contents', async t => {
    const c = fixture(t), first = await c.read(), stat = fs.statSync(c.home, { bigint: true });
    fs.writeFileSync(`${c.home}/private-secret`, 'PRIVATE_HOME_SENTINEL');
    assert.deepEqual(await c.read(), first, 'Ordinary home contents do not replace its identity.');
    assert.equal(first.homeTarget, `/home/${c.robotId}`);
    assert.deepEqual(first.identity, Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode'].map(key => [key, String(stat[key])])));
    assert.ok(!JSON.stringify(first).includes(c.dataRoot));
    assert.ok(!JSON.stringify(first).includes('PRIVATE_HOME_SENTINEL'));
});

for (const [name, mutate] of Object.entries({
    'wrong owner': c => fs.writeFileSync(`${c.root}/label`, JSON.stringify({ id: 'another-robot', name: c.robotName })),
    'wrong registered name': c => fs.writeFileSync(`${c.root}/label`, JSON.stringify({ id: c.robotId, name: 'foreign' })),
    'symlink home': c => { fs.renameSync(c.home, `${c.home}-real`); fs.symlinkSync(`${c.home}-real`, c.home); },
    'symlink label': c => { fs.renameSync(`${c.root}/label`, `${c.root}/label-real`); fs.symlinkSync(`${c.root}/label-real`, `${c.root}/label`); },
    'hardlinked label': c => fs.linkSync(`${c.root}/label`, `${c.dataRoot}/label-copy`),
    'non-directory home': c => { fs.rmdirSync(c.home); fs.writeFileSync(c.home, 'foreign'); },
})) test(`private home observation rejects ${name}`, async t => { const c = fixture(t); mutate(c); await assert.rejects(c.read()); });

for (const [name, mutate] of Object.entries({
    'replaced home directory': c => { fs.renameSync(c.home, `${c.home}-old`); fs.mkdirSync(c.home); },
    'label mutation': c => fs.appendFileSync(`${c.root}/label`, ' '),
    'label replacement with identical bytes': c => { const bytes = fs.readFileSync(`${c.root}/label`); fs.renameSync(`${c.root}/label`, `${c.root}/label-old`); fs.writeFileSync(`${c.root}/label`, bytes); },
})) test(`private home observation fences ${name} during capture`, async t => {
    const c = fixture(t), original = c.fsApi.readFileSync;
    c.fsApi.readFileSync = fd => { const bytes = original(fd); mutate(c); return bytes; };
    await assert.rejects(c.read(), /changed during capture/);
});
