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

test('private home observation rejects a wrong registered owner', async t => {
    const c = fixture(t);
    fs.writeFileSync(`${c.root}/label`, JSON.stringify({ id: 'another-robot', name: c.robotName }));
    await assert.rejects(c.read());
});

test('private home observation fences a replaced home directory during capture', async t => {
    const c = fixture(t), original = c.fsApi.readFileSync;
    c.fsApi.readFileSync = fd => { const bytes = original(fd); fs.renameSync(c.home, `${c.home}-old`); fs.mkdirSync(c.home); return bytes; };
    await assert.rejects(c.read(), /changed during capture/);
});
