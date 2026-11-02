import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { collectControllerProducer, collectControllerProducerCensus } from './robowork-process-evidence.mjs';

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
    context.census = () => collectControllerProducerCensus(10, { ...options, cwd }, io);
    return context;
}

test('independent controller census refuses source/interpreter/ancestry drift and malformed or unknown wrapper advertisements', async () => {
    for (const mutate of [
        f => { f.source = Buffer.from('foreign source'); },
        f => { f.rows.get(60).executable = '/bin/sh'; },
        f => { f.rows.get(60).ppid = 1; },
        f => { f.rows.get(60).argv[1] = '/foreign/robot-task.mjs'; },
        f => { f.rows.get(60).argv.push('--turn-id', 'invented'); },
        f => { f.rows.get(60).argv.push('--cwd', '/foreign'); },
        f => { f.rows.get(60).argv[6] = '--control-stdin=true'; },
        f => { f.hook = file => { if (file.includes('/root/code/')) f.rows.get(60).start = 'reused'; }; },
    ]) {
        const f = fixture();
        f.rows.get(60).argv = ['node', '/code/server/robot-task.mjs', '--cwd', f.record.cwd, '--session-id', 'pending', '--control-stdin'];
        mutate(f); await assert.rejects(f.census());
    }
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

test('the producer accepts --flag=value once, rejects duplicates, and a ppid 0 producer needs the exact identity', async () => {
    const inline = fixture(); inline.rows.get(40).argv = ['node', '/code/server/robot-cli.mjs', `--dir=${inline.record.cwd}`];
    assert.equal((await inline.read()).producer.pid, 40);
    for (const mutate of [
        f => { f.rows.get(40).argv.push('--dir', f.record.cwd); },
        f => { f.rows.get(40).argv = ['node', '/code/server/robot-cli.mjs', `--dir=${f.record.cwd}`, `--dir=${f.record.cwd}`]; },
        f => { f.rows.get(40).argv = ['node', '/code/server/robot-cli.mjs', '--dir=']; },
        f => { f.rows.get(40).argv = ['node', '/code/server/robot-cli.mjs', '--dir=/foreign']; },
    ]) { const f = fixture(); mutate(f); await assert.rejects(f.read()); }
    const exec = fixture(); exec.rows.get(40).ppid = 0;
    assert.equal((await exec.read()).producer.pid, 40);
    for (const mutate of [
        f => { f.source = Buffer.from('foreign source'); },
        f => { f.rows.get(40).executable = '/bin/sh'; },
        f => { f.rows.get(40).argv[1] = '/foreign/robot-cli.mjs'; },
        f => { f.rows.get(40).ppid = 77; },
        f => { f.rows.get(40).ppid = 80; },
    ]) { const f = fixture(); f.rows.get(40).ppid = 0; mutate(f); await assert.rejects(f.read()); }
});

test('only a copilot producer may have ppid 0; task and attach producers keep the descent proof', async () => {
    const taskArgs = f => ['node', '/code/server/robot-task.mjs', '--cwd', f.record.cwd, '--session-id', f.record.sessionId, '--control-stdin'];
    const task = fixture(); task.record.kind = 'task'; task.rows.get(40).argv = taskArgs(task);
    assert.equal((await task.read()).producer.pid, 40);
    task.rows.get(40).ppid = 0; await assert.rejects(task.read());
    const attach = fixture(); attach.record.kind = 'task'; attach.options.attach = true;
    attach.rows.get(40).argv = [...taskArgs(attach), '--attach-run', attach.record.runId];
    assert.equal((await attach.read()).producer.pid, 40);
    attach.rows.get(40).ppid = 0; await assert.rejects(attach.read());
});
