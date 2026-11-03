import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readResidentRunRecords } from './robowork-run-evidence.mjs';

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resident-run-evidence-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repository = path.join(root, 'AchillesIDE'), code = path.join(repository, 'roboWorkAgent');
    const data = path.join(root, 'private'), runs = path.join(data, 'runs');
    fs.mkdirSync(path.join(code, 'server'), { recursive: true }); fs.mkdirSync(runs, { recursive: true, mode: 0o700 }); fs.chmodSync(data, 0o700);
    const source = 'export const canonical = true;\n'; fs.writeFileSync(path.join(code, 'server/main.mjs'), source);
    const record = { runId: randomUUID(), robotId: 'robot-a', cwd: path.join(root, 'project'), state: 'running',
        tag: { kind: 'copilot', sessionId: 'session-one', turnId: 'turn-one', ownerPrincipal: 'user:owner',
            producer: { pid: 31, startStamp: '67890' }, privateExtra: 'SYNTHETIC_PRIVATE_VALUE' },
        ala: { sessionId: 'session-one', turnId: 'turn-one' }, pid: 21, servicePid: 8, pidStamp: '12345', launchId: randomUUID() };
    const directory = path.join(runs, record.runId); fs.mkdirSync(directory, { mode: 0o700 });
    const file = path.join(directory, 'meta.json');
    const write = value => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); write(record);
    const descriptors = new Map();
    const io = { ...fs,
        openSync(file, ...args) { const fd = fs.openSync(file, ...args); descriptors.set(fd, file); return fd; },
        closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd); },
        realpathSync(file) {
            if (/^\/proc\/self\/fd\/[0-9]+$/u.test(file)) return fs.realpathSync(descriptors.get(Number(path.basename(file))));
            return fs.realpathSync(file);
        },
    };
    const options = { expectedRepository: repository, robotId: record.robotId, cwd: record.cwd,
        contractFiles: ['server/main.mjs'], contractHashes: { 'server/main.mjs': createHash('sha256').update(source).digest('hex') } };
    return { root, code, data, runs, record, directory, file, write, io, options,
        read: (override = {}) => readResidentRunRecords({ ...options, ...override }, { fsApi: io, codeRoot: code, dataRoot: data }) };
}

test('metadata symlinks, hardlinks and owner-writable directories cannot authorize a run', async t => {
    const f = fixture(t);
    fs.renameSync(f.file, `${f.root}/foreign.json`); fs.symlinkSync(`${f.root}/foreign.json`, f.file);
    await assert.rejects(f.read()); fs.unlinkSync(f.file); fs.linkSync(`${f.root}/foreign.json`, f.file);
    await assert.rejects(f.read()); fs.unlinkSync(f.file); f.write(f.record);
    fs.chmodSync(f.directory, 0o777); await assert.rejects(f.read()); fs.chmodSync(f.directory, 0o700);
    fs.chmodSync(f.file, 0o644); await assert.rejects(f.read());
});
