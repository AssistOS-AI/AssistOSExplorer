import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { collectControllerProducer, buildControllerProducerProgram } from './robowork-process-evidence.mjs';
import { spawnSync } from 'node:child_process';

function fixture() {
    const cwd = '/fixture/project', source = Buffer.from('canonical controller source');
    const rows = new Map([
        [10, { pid: 10, ppid: 1, start: '100', namespace: 'pid:[111]', localPid: 1, argv: ['init'] }],
        [40, { pid: 40, ppid: 10, start: '400', namespace: 'pid:[111]', localPid: 7,
            argv: ['node', '/code/server/robot-cli.mjs', '--dir', cwd] }],
        [60, { pid: 60, ppid: 10, start: '600', namespace: 'pid:[111]', localPid: 9,
            argv: ['node', '/code/server/robot-cli.mjs', '--dir', cwd] }],
        [80, { pid: 80, ppid: 1, start: '800', namespace: 'pid:[222]', localPid: 7, argv: ['unrelated-container-init'] }],
    ]);
    const record = { runId: 'resident-run', kind: 'copilot', cwd, sessionId: 'session', turnId: 'turn', producer: { pid: 7, startStamp: '400' } };
    const options = { codeRoot: '/code', scriptSha256: createHash('sha256').update(source).digest('hex') };
    const descriptors = new Map(); let next = 1;
    const context = { rows, record, options, source, hook: null };
    const bytes = file => {
        context.hook?.(file);
        const match = /^\/proc\/([0-9]+)\/(stat|status|cmdline|root\/code\/server\/(?:robot-cli|robot-task)\.mjs)$/u.exec(file);
        assert.ok(match, 'Only bounded process identity and canonical source may be read.');
        const row = rows.get(Number(match[1]));
        if (!row) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
        if (match[2] === 'stat') return Buffer.from(`${row.pid} (controller) S ${row.ppid} ${Array(17).fill('0').join(' ')} ${row.start}\n`);
        if (match[2] === 'status') return Buffer.from(`Name:\tcontroller\nNSpid:\t${row.pid}\t${row.localPid}\n`);
        if (match[2] === 'cmdline') return Buffer.from(row.argv.join('\0') + '\0');
        return context.source;
    };
    const io = { constants: fs.constants,
        readdirSync(file) { assert.equal(file, '/proc'); return [...rows.keys()].map(String); },
        openSync(file) { const fd = next++; descriptors.set(fd, { file, bytes: bytes(file), offset: 0 }); return fd; },
        closeSync(fd) { descriptors.delete(fd); },
        readSync(fd, buffer, offset, length) {
            const entry = descriptors.get(fd), count = Math.min(length, entry.bytes.length - entry.offset);
            entry.bytes.copy(buffer, offset, entry.offset, entry.offset + count); entry.offset += count; return count;
        },
        readFileSync(fd) { return descriptors.get(fd).bytes; },
        fstatSync(fd) { return { isFile: () => true, nlink: 1n, size: BigInt(descriptors.get(fd).bytes.length),
            dev: 1n, ino: 2n, uid: 0n, gid: 0n, mode: 0o100600n, mtimeNs: 1n, ctimeNs: 1n }; },
        readlinkSync(file) {
            const match = /^\/proc\/([0-9]+)\/(ns\/pid|exe)$/u.exec(file); assert.ok(match);
            const row = rows.get(Number(match[1])); if (!row) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            return match[2] === 'exe' ? row.executable || '/usr/bin/node' : row.namespace;
        },
    };
    context.read = (initPid = 10) => collectControllerProducer(initPid, record, options, io);
    return context;
}

test('controller proof links trusted run ID to exact process incarnation, canonical script and init ancestry', async () => {
    const f = fixture(), proof = await f.read();
    assert.equal(proof.runId, f.record.runId); assert.equal(proof.producer.pid, 40);
    assert.equal(proof.producer.startToken, '400'); assert.equal(proof.producer.sha256, f.options.scriptSha256);
    assert.deepEqual(proof.producerAncestry.map(row => row.pid), [40]);
    assert.equal(proof.containerInit.pid, 10); assert.equal(f.rows.size, 4);
});

test('different producer, dead producer, reused PID and wrong container all fail', async () => {
    for (const mutate of [
        f => { f.record.producer.pid = 9; }, f => { f.rows.delete(40); },
        f => { f.rows.get(40).start = '401'; }, f => { f.rows.get(40).namespace = 'pid:[222]'; },
        f => { f.rows.get(40).ppid = 1; },
    ]) {
        const f = fixture(); mutate(f); await assert.rejects(f.read());
    }
    const foreign = fixture(); await assert.rejects(foreign.read(80));
});

test('wrong source, executable, cwd and ambiguous process metadata fail', async () => {
    for (const mutate of [
        f => { f.source = Buffer.from('same name, foreign source'); },
        f => { f.rows.get(40).executable = '/bin/sh'; },
        f => { f.rows.get(40).argv[1] = '/other/server/robot-cli.mjs'; },
        f => { f.rows.get(40).argv[3] = '/foreign'; },
        f => { f.rows.get(40).argv.push('--dir', f.record.cwd); },
        f => { const duplicate = structuredClone(f.rows.get(40)); duplicate.pid = 41; f.rows.set(41, duplicate); },
    ]) {
        const f = fixture(); mutate(f); await assert.rejects(f.read());
    }
});

test('workflow producer retains exact session and control-stdin requirements', async () => {
    const f = fixture(); f.record.kind = 'task';
    f.rows.get(40).argv = ['node', '/code/server/robot-task.mjs', '--cwd', f.record.cwd, '--session-id', 'session', '--control-stdin'];
    assert.equal((await f.read()).producer.kind, 'workflow');
    f.rows.get(40).argv[5] = 'foreign-session'; await assert.rejects(f.read());
});

test('replacement task proves attach-run in the current exact controller namespace without reviving the original producer', async () => {
    const f = fixture(); f.record.kind = 'task'; f.options.attach = true;
    f.rows.delete(40);
    f.rows.get(60).argv = ['node', '/code/server/robot-task.mjs', '--cwd', f.record.cwd, '--session-id', 'session',
        '--control-stdin', '--attach-run', f.record.runId];
    const proof = await f.read();
    assert.equal(proof.producer.pid, 60); assert.equal(proof.producer.startToken, '600');
    assert.equal(proof.attachRun, f.record.runId); assert.deepEqual(f.record.producer, { pid: 7, startStamp: '400' });
    f.options.attach = false; await assert.rejects(f.read(), /dead or ambiguous/u);
});

test('reattachment refuses a wrong run ID, wrong session, wrong current container and a dead replacement', async () => {
    const prepare = () => {
        const f = fixture(); f.record.kind = 'task'; f.options.attach = true; f.rows.delete(40);
        f.rows.get(60).argv = ['node', '/code/server/robot-task.mjs', '--cwd', f.record.cwd, '--session-id', 'session',
            '--control-stdin', '--attach-run', f.record.runId];
        return f;
    };
    for (const mutate of [
        f => { f.rows.get(60).argv[8] = 'another-run'; },
        f => { f.rows.get(60).argv[5] = 'another-session'; },
        f => { f.rows.get(60).namespace = 'pid:[222]'; },
        f => { f.rows.delete(60); },
        f => { f.rows.get(60).argv.push('--attach-run', f.record.runId); },
    ]) { const f = prepare(); mutate(f); await assert.rejects(f.read()); }
    await assert.rejects(prepare().read(80));
});

test('controller identity changing during source capture fails final settlement', async () => {
    const f = fixture(); f.hook = file => { if (file.endsWith('/root/code/server/robot-cli.mjs')) f.rows.get(40).start = '401'; };
    await assert.rejects(f.read(), /changed during observation/u);
});

test('serialized controller proof is self-contained and refuses missing identities without raw errors', () => {
    const source = buildControllerProducerProgram(1, {}, {});
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], { input: source, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'Invalid exact controller-producer evidence');
});
