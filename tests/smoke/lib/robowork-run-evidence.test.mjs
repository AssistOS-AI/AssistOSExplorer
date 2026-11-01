import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readResidentRunRecords, buildResidentRunProgram } from './robowork-run-evidence.mjs';

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

test('resident evidence reads private authoritative metadata and projects no opaque tag data', async t => {
    const f = fixture(t); const before = fs.readFileSync(f.file);
    const result = await f.read();
    assert.equal(result.records.length, 1); assert.equal(result.records[0].runId, f.record.runId);
    assert.equal(result.records[0].ownerPrincipal, 'user:owner');
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_VALUE'));
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal((await f.read({ robotId: 'robot-b' })).records.length, 0);
    assert.equal((await f.read({ cwd: `${f.root}/another-project` })).records.length, 0);
});

test('resident metadata requires exact identity, session, turn, owner and live process stamps', async t => {
    const f = fixture(t);
    for (const mutate of [
        value => { value.runId = randomUUID(); }, value => { value.tag.sessionId = 'foreign'; },
        value => { value.tag.turnId = 'foreign'; }, value => { value.tag.kind = 'invented'; },
        value => { value.tag.ownerPrincipal = 'agent:foreign'; }, value => { value.pidStamp = ''; },
        value => { delete value.tag.producer; }, value => { value.tag.producer.pid = 0; },
        value => { value.tag.producer.startStamp = ''; }, value => { value.tag.producer.invented = 'authority'; },
        value => { value.pid = 0; }, value => { value.servicePid = null; }, value => { value.state = 'invented'; },
    ]) {
        const changed = structuredClone(f.record); mutate(changed); f.write(changed);
        await assert.rejects(f.read());
    }
});

test('model-discovery helper directories do not become resident runs and missing native metadata still fails', async t => {
    const f = fixture(t), helper = path.join(f.runs, `models-${randomUUID()}`);
    fs.mkdirSync(helper, { mode: 0o700 }); fs.writeFileSync(path.join(helper, 'launch.sh'), '#!/bin/sh\n', { mode: 0o700 });
    assert.equal((await f.read()).records.length, 1);
    fs.writeFileSync(path.join(helper, 'unexpected'), 'not a model helper'); await assert.rejects(f.read());
    fs.rmSync(helper, { recursive: true }); fs.unlinkSync(f.file); await assert.rejects(f.read());
});

test('starting metadata retains trusted producer and ownership while launch process fields are not yet available', async t => {
    const f = fixture(t); f.record.state = 'starting';
    for (const field of ['pid', 'servicePid', 'pidStamp']) delete f.record[field];
    f.write(f.record);
    const result = await f.read();
    assert.equal(result.records.length, 1); assert.equal(result.records[0].state, 'starting');
    assert.deepEqual(result.records[0].producer, f.record.tag.producer);
    assert.equal(result.records[0].ownerPrincipal, 'user:owner');
    assert.equal('pid' in result.records[0], false);
    f.record.tag.ownerPrincipal = 'agent:foreign'; f.write(f.record); await assert.rejects(f.read());
});

test('metadata symlinks, hardlinks and owner-writable directories cannot authorize a run', async t => {
    const f = fixture(t);
    fs.renameSync(f.file, `${f.root}/foreign.json`); fs.symlinkSync(`${f.root}/foreign.json`, f.file);
    await assert.rejects(f.read()); fs.unlinkSync(f.file); fs.linkSync(`${f.root}/foreign.json`, f.file);
    await assert.rejects(f.read()); fs.unlinkSync(f.file); f.write(f.record);
    fs.chmodSync(f.directory, 0o777); await assert.rejects(f.read()); fs.chmodSync(f.directory, 0o700);
    fs.chmodSync(f.file, 0o644); await assert.rejects(f.read());
});

test('wrong RoboTeam source, modified source and managed checkout fail before run evidence counts', async t => {
    const f = fixture(t);
    const foreign = path.join(f.options.expectedRepository, 'roboTeamAgent'); fs.mkdirSync(foreign);
    await assert.rejects(readResidentRunRecords(f.options, { fsApi: f.io, codeRoot: foreign, dataRoot: f.data }));
    fs.appendFileSync(path.join(f.code, 'server/main.mjs'), '// drift'); await assert.rejects(f.read());
    await assert.rejects(f.read({ expectedRepository: `${f.root}/.ploinky/repos/AchillesIDE` }), /Managed source/u);
});

test('metadata replacement during an open read fails the inode and final settlement fences', async t => {
    const f = fixture(t); const read = f.io.readFileSync;
    f.io.readFileSync = (fd, ...args) => {
        const bytes = read(fd, ...args);
        if (f.io.realpathSync(`/proc/self/fd/${fd}`) === f.file) {
            const other = `${f.file}.next`; fs.writeFileSync(other, JSON.stringify(f.record), { mode: 0o600 }); fs.renameSync(other, f.file);
        }
        return bytes;
    };
    await assert.rejects(f.read());
});

test('serialized resident evidence is self-contained and fails closed without an admitted source', () => {
    const source = buildResidentRunProgram({ expectedRepository: '/missing/original', robotId: 'robot-a', cwd: '/project', contractFiles: ['server/main.mjs'], contractHashes: {} });
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], { input: source, encoding: 'utf8', timeout: 8000 });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'Invalid private resident-run evidence');
    assert.doesNotMatch(result.stderr, /ReferenceError|SyntaxError/u);
});
