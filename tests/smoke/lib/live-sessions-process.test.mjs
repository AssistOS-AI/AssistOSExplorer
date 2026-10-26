import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import test from 'node:test';
import { collectNativeProcessSnapshot, NATIVE_PROCESS_SNAPSHOT_SOURCE, assertNativeProcessIdentity, assertNativeProcessCensus } from './live-sessions.mjs';

const execute = promisify(execFile);
const cwd = '/workspace/selected';
const bytes = Buffer.from('public native fixture');
const native = { realpath: '/public/native', sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
const alaBytes = Buffer.from('public canonical ALA entrypoint fixture');
const alaBinding = { root: '/public', command: '/public/bin/ala.mjs', hashes: { 'bin/ala.mjs': crypto.createHash('sha256').update(alaBytes).digest('hex') } };
const turnArgs = ['node', alaBinding.command, '--cwd', cwd, '--session-id', 'session', '--turn-id', 'turn', '--control-stdin'];
const selectionFor = (kind = 'copilot', sessionId = 'session', turnId = 'turn') => ({ kind, sessionId, turnId, codeRoot: '/code',
    workflowCodeRoot: '/source/roboTeamAgent', alaBinding });

// This is process metadata, not a second scanner. The production algorithm
// receives only fs-shaped operations; it still performs all parsing/selection.
function snapshotFixture() {
    const rows = new Map();
    const add = (pid, ppid, args, extra = {}) => rows.set(pid, {
        pid, ppid, startToken: String(pid + 100), pidNamespace: 'pid:[100]', args,
        executable: '/usr/bin/node', state: 'S', ...extra,
    });
    add(10, 1, ['init']);
    add(20, 40, [...turnArgs]); // Same namespace, intentionally no init ancestry.
    add(40, 1, ['node', '/code/server/robot-cli.mjs', '--dir', cwd]);
    add(21, 20, ['bwrap'], { executable: '/usr/bin/bwrap' });
    add(22, 21, [native.realpath], { executable: native.realpath, pidNamespace: 'pid:[200]' });
    add(30, 1, [native.realpath], { executable: native.realpath }); // Unrelated same binary.
    const calls = new Map(), descriptors = new Map();
    let nextFd = 1;
    const fixture = { rows, add, calls, descriptors, hook: null, fileBytes: bytes, alaBytes, alaIno: 2n, inventory: null };
    function access(file) {
        const count = (calls.get(file) || 0) + 1;
        calls.set(file, count);
        fixture.hook?.(file, count);
        const match = file.match(/^\/proc\/([1-9][0-9]*)\/(stat|cmdline|ns\/pid|exe|root\/public\/(?:native|bin\/ala\.mjs))$/);
        assert.ok(match, 'observer must access only metadata and the selected public executable');
        const row = rows.get(Number(match[1]));
        if (!row) throw Object.assign(new Error('fixture process absent'), { code: 'ENOENT' });
        const kind = match[2];
        if (kind === 'ns/pid') return row.pidNamespace;
        if (kind === 'exe') return row.executable;
        if (kind === 'root/public/native') return fixture.fileBytes;
        if (kind === 'root/public/bin/ala.mjs') return fixture.alaBytes;
        if (kind === 'cmdline') return row.rawCmdline ?? Buffer.from(row.args.join('\0') + '\0');
        const fields = [row.state, String(row.ppid), ...Array(17).fill('0'), row.startToken];
        return row.rawStat ?? Buffer.from(`${row.pid} (fixture process) ${fields.join(' ')}\n`);
    }
    fixture.io = {
        constants: fs.constants,
        readdirSync(file) { assert.equal(file, '/proc'); return fixture.inventory ?? [...rows.keys()].map(String); },
        readlinkSync: access,
        openSync(file, flags) {
            if (file.endsWith('/root/public/bin/ala.mjs')) assert.equal(flags, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            const value = access(file);
            assert.ok(Buffer.isBuffer(value));
            const fd = nextFd++;
            descriptors.set(fd, { value, file, offset: 0 });
            return fd;
        },
        readSync(fd, buffer, offset, length) {
            const descriptor = descriptors.get(fd);
            const size = Math.min(length, descriptor.value.length - descriptor.offset);
            descriptor.value.copy(buffer, offset, descriptor.offset, descriptor.offset + size);
            descriptor.offset += size;
            return size;
        },
        fstatSync(fd, options) {
            const size = descriptors.get(fd).value.length;
            return options?.bigint ? { isFile: () => true, size: BigInt(size), nlink: 1n, ino: fixture.alaIno,
                dev: 1n, mode: 0o100600n, uid: 1n, gid: 1n, mtimeNs: 1n, ctimeNs: 1n } : { isFile: () => true, size };
        },
        lstatSync(file) { return { isFile: () => true, size: BigInt(access(file).length), nlink: 1n, ino: fixture.alaIno,
            dev: 1n, mode: 0o100600n, uid: 1n, gid: 1n, mtimeNs: 1n, ctimeNs: 1n }; },
        closeSync(fd) { assert.equal(descriptors.delete(fd), true); },
    };
    fixture.observe = (rootPid = 10, selectedCwd = cwd) => collectNativeProcessSnapshot(rootPid, native, selectedCwd, fixture.io, selectionFor());
    return fixture;
}

test('same namespace selects a non-init-descendant ALA and preserves the entire native ancestry', async () => {
    const fixture = snapshotFixture();
    const first = await fixture.observe();
    assertNativeProcessIdentity(first, native, { initPid: 10, cwd, ...selectionFor() });
    assert.equal(first.ala.ppid, 40);
    assert.equal(first.native.pidNamespace, 'pid:[200]', 'the native sandbox may unshare its PID namespace');
    assert.deepEqual(first.ancestry.map(row => row.pid), [22, 21]);
    assert.equal(first.native.pid, 22, 'unrelated same binary and Bubblewrap are excluded');
    assert.deepEqual(await fixture.observe(), first);
    assert.equal(fixture.rows.size, 6, 'observation creates no execution');
});

test('observed IDs select distinct same-cwd workers with exact producer ancestry and scoped census', async () => {
    const fixture = snapshotFixture();
    fixture.rows.get(20).ppid = 40;
    fixture.add(40, 1, ['node', '/code/server/robot-cli.mjs', '--dir', cwd]);
    const otherArgs = [...turnArgs]; otherArgs[5] = 'worker-session'; otherArgs[7] = 'worker-turn';
    fixture.add(50, 60, otherArgs);
    fixture.add(51, 50, [native.realpath], { executable: native.realpath });
    fixture.add(60, 1, ['node', '/source/roboTeamAgent/server/robot-task.mjs', '--cwd', cwd, '--session-id', 'worker-session', '--control-stdin']);
    const select = selectionFor;
    const observe = selection => collectNativeProcessSnapshot(10, native, cwd, fixture.io, selection);
    await assert.rejects(collectNativeProcessSnapshot(10, native, cwd, fixture.io), /frozen ALA binding/, 'Pathless flag-only selection is forbidden.');
    const front = await observe(select('copilot', 'session', 'turn'));
    const worker = await observe(select('workflow', 'worker-session', 'worker-turn'));
    assert.equal(front.ala.pid, 20); assert.equal(worker.ala.pid, 50);
    assert.equal(front.producer.pid, 40); assert.equal(worker.producer.pid, 60);
    assertNativeProcessIdentity(worker, native, { initPid: 10, cwd, ...select('workflow', 'worker-session', 'worker-turn') });
    const census = await observe(select('census'));
    assert.equal(census.length, 2); assert.ok(census.every(row => row.kind === 'ala-turn'));
    assertNativeProcessCensus(census, { cwd, ...select('census') });
    for (const selection of [select('copilot', '../invalid', 'turn'), select('copilot', 'absent', 'turn'),
        select('workflow', 'session', 'turn')]) await assert.rejects(observe(selection));
    fixture.add(70, 40, [...turnArgs]);
    await assert.rejects(observe(select('copilot', 'session', 'turn')), /exactly one selected/);
    fixture.rows.delete(70);
    for (const args of [['node', '/other/robot-cli.mjs', '--dir', cwd], ['node', '--eval', '/code/server/robot-cli.mjs', '--dir', cwd],
        ['node', '/code/server/robot-cli.mjs', '--dir', '/other/selected']]) {
        fixture.rows.get(40).args = args;
        await assert.rejects(observe(select('copilot', 'session', 'turn')));
    }
});

test('producer replacement and argv/namespace races fail the final observer fence', async () => {
    for (const field of ['startToken', 'ppid', 'pidNamespace', 'args']) {
        const fixture = snapshotFixture();
        fixture.rows.get(20).ppid = 40;
        fixture.add(40, 1, ['node', '/code/server/robot-cli.mjs', '--dir', cwd]);
        let armed = false;
        fixture.hook = file => {
            if (file === '/proc/22/root/public/native') armed = true;
            if (!armed || file !== '/proc/40/stat') return;
            armed = false;
            const producer = fixture.rows.get(40);
            if (field === 'startToken') producer.startToken += '1';
            if (field === 'ppid') producer.ppid = 999;
            if (field === 'pidNamespace') producer.pidNamespace = 'pid:[999]';
            if (field === 'args') producer.args.push('--changed');
        };
        await assert.rejects(collectNativeProcessSnapshot(10, native, cwd, fixture.io,
            selectionFor()));
    }
    const empty = snapshotFixture(); empty.rows.delete(20);
    assert.deepEqual(await collectNativeProcessSnapshot(10, native, cwd, empty.io, selectionFor('census')), []);
});

test('native file replacement between selection and final hash fence cannot pass', async () => {
    const fixture = snapshotFixture();
    fixture.hook = (file, count) => {
        if (file === '/proc/22/root/public/native' && count === 2) fixture.fileBytes = Buffer.from('replaced public executable');
    };
    await assert.rejects(fixture.observe(), /hash drift/);
});

test('producer interpreter replacement cannot preserve an otherwise unchanged identity', async () => {
    const fixture = snapshotFixture();
    fixture.rows.get(20).ppid = 40;
    fixture.add(40, 1, ['node', '/code/server/robot-cli.mjs', '--dir', cwd]);
    fixture.hook = (file, count) => {
        if (file === '/proc/40/exe' && count === 2) fixture.rows.get(40).executable = '/usr/bin/untrusted';
    };
    await assert.rejects(collectNativeProcessSnapshot(10, native, cwd, fixture.io,
        selectionFor()), /producer executable changed/);
});

test('native script matching accepts only the exact script position of a supported interpreter', async () => {
    const fixture = snapshotFixture();
    const row = fixture.rows.get(22);
    row.executable = '/usr/bin/node';
    row.args = ['/usr/bin/node', native.realpath];
    const identity = await fixture.observe();
    assert.equal(identity.native.scriptPath, native.realpath);
    assertNativeProcessIdentity(identity, native, { initPid: 10, cwd, ...selectionFor() });
    for (const args of [['node', '/different/script', native.realpath], ['node', '--eval', native.realpath]]) {
        row.args = args;
        await assert.rejects(fixture.observe(), /exactly one frozen/);
    }
    row.args = ['/untrusted/interpreter', native.realpath];
    row.executable = '/untrusted/interpreter';
    await assert.rejects(fixture.observe(), /exactly one frozen/);
});

test('required arguments reject missing, duplicate, empty, equals and malformed values', async t => {
    for (const flag of ['--cwd', '--session-id', '--turn-id', '--control-stdin']) {
        for (const mode of ['missing', 'duplicate', 'equals', ...(flag === '--control-stdin' ? [] : ['empty', 'flag-value', 'control', 'oversized'])]) {
            await t.test(`${flag} ${mode}`, async () => {
                const fixture = snapshotFixture(), args = fixture.rows.get(20).args;
                const index = args.indexOf(flag), valued = flag !== '--control-stdin';
                if (mode === 'missing') args.splice(index, valued ? 2 : 1);
                if (mode === 'duplicate') args.push(flag, ...(valued ? ['duplicate'] : []));
                if (mode === 'equals') args.splice(index, valued ? 2 : 1, flag + '=value');
                if (mode === 'empty') args[index + 1] = '';
                if (mode === 'flag-value') args[index + 1] = '--other';
                if (mode === 'control') args[index + 1] = 'value\n';
                if (mode === 'oversized') args[index + 1] = 'x'.repeat(4097);
                await assert.rejects(fixture.observe());
            });
        }
    }
});

const adversarialCases = {
    'wrong ALA namespace': f => { f.rows.get(20).pidNamespace = 'pid:[999]'; },
    'identical basename in another workspace': f => { f.rows.get(20).args[3] = '/other/selected'; },
    'cwd-like unrelated option': f => { f.rows.get(20).args.splice(2, 2, '--other', cwd); },
    'zero ALA': f => { f.rows.get(20).args = ['node']; },
    'two ALA parents': f => { f.add(40, 1, [...turnArgs]); },
    'two native matches': f => { f.add(23, 20, [native.realpath], { executable: native.realpath }); },
    'missing native': f => { f.rows.delete(22); },
    'broken native ancestry': f => { f.rows.get(21).ppid = 999; },
    'ancestry cycle': f => { f.rows.get(21).ppid = 22; },
    'hash drift': f => { f.fileBytes = Buffer.from('changed binary'); },
    'empty executable': f => { f.fileBytes = Buffer.alloc(0); },
    'unbounded inventory': f => { f.inventory = Array(8193).fill('10'); },
    'malformed stat': f => { f.rows.get(20).rawStat = Buffer.from('malformed'); },
    'wrong stat PID': f => { f.rows.get(20).rawStat = Buffer.from('999 (wrong) S 1 ' + '0 '.repeat(17) + '120'); },
    'invalid start token': f => { f.rows.get(20).startToken = '0'; },
    'oversized start token': f => { f.rows.get(20).startToken = '1'.repeat(21); },
    'invalid PPID': f => { f.rows.get(20).ppid = -1; },
    'oversized stat': f => { f.rows.get(20).rawStat = Buffer.alloc(65537); },
    'oversized cmdline': f => { f.rows.get(20).rawCmdline = Buffer.alloc(65537); },
    'unterminated cmdline': f => { f.rows.get(20).rawCmdline = Buffer.from('node'); },
    'invalid UTF8 cmdline': f => { f.rows.get(20).rawCmdline = Buffer.from([255, 0]); },
    'malformed namespace': f => { f.rows.get(20).pidNamespace = 'pid:garbage'; },
    'oversized namespace': f => { f.rows.get(20).pidNamespace = 'pid:[' + '1'.repeat(10000) + ']'; },
    'permission denied': f => { f.hook = file => { if (file === '/proc/30/stat') throw Object.assign(new Error('denied'), { code: 'EACCES' }); }; },
    'unexpected read failure': f => { f.hook = file => { if (file === '/proc/30/stat') throw Object.assign(new Error('I/O'), { code: 'EIO' }); }; },
};

test('adversarial process metadata cannot satisfy the production observer', async t => {
    for (const [name, mutate] of Object.entries(adversarialCases)) {
        await t.test(name, async () => {
            const fixture = snapshotFixture();
            mutate(fixture);
            await assert.rejects(fixture.observe());
        });
    }
    for (const rootPid of [0, 1, -1, 1.5, NaN, '10', Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(snapshotFixture().observe(rootPid), /invalid exact process context/);
    }
    for (const selectedCwd of ['', '/', 'relative', '/workspace/../selected', '/workspace//selected', '/workspace/selected\0']) {
        await assert.rejects(snapshotFixture().observe(10, selectedCwd), /invalid exact process context/);
    }
});

test('all init, ALA, native and intermediate identities have final race fences', async t => {
    for (const pid of [10, 20, 21, 22]) {
        for (const field of ['startToken', 'ppid', 'pidNamespace', 'args', 'missing']) {
            await t.test(`${pid} ${field}`, async () => {
                const fixture = snapshotFixture();
                // Arm only once the selected executable has been opened. The
                // mutation lands after selection, during hash/proof/final fences.
                let armed = false;
                fixture.hook = file => {
                    if (file === '/proc/22/root/public/native') armed = true;
                    if (!armed || file !== `/proc/${pid}/stat`) return;
                    armed = false;
                    const row = fixture.rows.get(pid);
                    if (field === 'startToken') row.startToken += '1';
                    if (field === 'ppid') row.ppid = 999;
                    if (field === 'pidNamespace') row.pidNamespace = 'pid:[999]';
                    if (field === 'args') row.args.push('--changed');
                    if (field === 'missing') fixture.rows.delete(pid);
                };
                await assert.rejects(fixture.observe());
            });
        }
    }
});

test('only unrelated inventory disappearance is tolerated', async () => {
    const fixture = snapshotFixture();
    fixture.hook = file => {
        if (file === '/proc/30/stat') throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    };
    assert.equal((await fixture.observe()).native.pid, 22);
});

test('frozen ALA binding is mandatory and invalid bindings fail before proc access', async () => {
    for (const binding of [undefined, null, {}, { ...alaBinding, command: 'relative' }, { ...alaBinding, root: '/public/../public' },
        { ...alaBinding, command: `${alaBinding.command}\n` }, { ...alaBinding, command: '/other/bin/ala.mjs' },
        { ...alaBinding, hashes: {} }, { ...alaBinding, hashes: { 'bin/ala.mjs': 'A'.repeat(64) } }]) {
        const f = snapshotFixture(); let accessed = false;
        const io = { ...f.io, readdirSync() { accessed = true; throw new Error('proc should not be accessed'); } };
        await assert.rejects(collectNativeProcessSnapshot(10, native, cwd, io, { ...selectionFor(), alaBinding: binding }), /frozen ALA/);
        assert.equal(accessed, false);
    }
});

test('known workflow wrapper lifecycle remains a census blocker until both wrapper and ALA retire', async () => {
    const f = snapshotFixture(); f.rows.get(20).ppid = 60; f.rows.delete(40);
    f.add(60, 1, ['node', '/source/roboTeamAgent/server/robot-task.mjs', '--cwd', cwd, '--session-id', 'session', '--control-stdin']);
    const observe = () => collectNativeProcessSnapshot(10, native, cwd, f.io, selectionFor('census'));
    const ala = f.rows.get(20); f.rows.delete(20);
    const before = await observe(); assert.equal(before.length, 1); assert.equal(before[0].kind, 'producer-pending');
    assertNativeProcessCensus(before, { cwd, ...selectionFor('census') });
    for (const key of ['turnId', 'native', 'ala', 'entrypoint', 'sha256', 'producerKind']) {
        assert.throws(() => assertNativeProcessCensus([{ ...before[0], [key]: null }], { cwd, ...selectionFor('census') }));
    }
    await assert.rejects(collectNativeProcessSnapshot(10, native, cwd, f.io, selectionFor('workflow')), /exactly one/);
    f.rows.set(20, ala); const alive = await observe(); assert.equal(alive.length, 1); assert.equal(alive[0].kind, 'ala-turn');
    assert.equal((await collectNativeProcessSnapshot(10, native, cwd, f.io, selectionFor('workflow'))).ala.pid, 20);
    f.rows.delete(20); assert.deepEqual(await observe(), before);
    f.rows.delete(60); assert.deepEqual(await observe(), []);
});

test('role classification rejects unknown/eval advertisements and malformed wrappers before foreign-cwd exclusion', async () => {
    const wrapper = ['node', '/source/roboTeamAgent/server/robot-task.mjs', '--cwd', cwd, '--session-id', 'worker', '--control-stdin'];
    for (const args of [
        ['node', '/unknown/ala.mjs', ...turnArgs.slice(2)], ['node', '--eval', alaBinding.command, ...turnArgs.slice(2)],
        ['node', '/unknown/script', '--control-stdin=value'], [...wrapper, '--turn-id', 'invented'],
        [...wrapper, '--cwd', cwd], wrapper.map(value => value === '--control-stdin' ? '--control-stdin=true' : value),
        wrapper.filter(value => value !== '--control-stdin'),
        ['node', '/source/roboTeamAgent/server/robot-task.mjs', '--cwd', '/other/selected', '--control-stdin'],
    ]) {
        const f = snapshotFixture(); f.add(60, 1, args);
        await assert.rejects(f.observe()); assert.equal(f.descriptors.size, 0);
    }
    const f = snapshotFixture();
    f.add(60, 1, ['node', '--eval', `console.log('${alaBinding.command} --control-stdin --turn-id decoy')`]);
    f.add(70, 1, wrapper.map(value => value === cwd ? '/other/selected' : value));
    f.add(80, 70, turnArgs.map(value => value === cwd ? '/other/selected' : value));
    assert.equal((await f.observe()).ala.pid, 20);
});

test('ALA entrypoint, interpreter and pending-wrapper final races cannot turn into empty census', async t => {
    for (const change of ['source-bytes', 'source-inode', 'interpreter', 'entrypoint-read', 'entrypoint-size']) await t.test(change, async () => {
        const f = snapshotFixture();
        if (change === 'entrypoint-size') f.alaBytes = Buffer.alloc(4 * 1024 * 1024 + 1);
        f.hook = (file, count) => {
            if (file === '/proc/20/root/public/bin/ala.mjs') {
                if (change === 'entrypoint-read') throw Object.assign(new Error('unreadable pinned entrypoint'), { code: 'EACCES' });
                if (count === 3 && change === 'source-bytes') f.alaBytes = Buffer.from('different public ALA entrypoint');
                if (count === 3 && change === 'source-inode') f.alaIno += 1n;
            }
            if (file === '/proc/20/exe' && count === 2 && change === 'interpreter') f.rows.get(20).executable = '/usr/bin/nodejs';
        };
        await assert.rejects(f.observe()); assert.equal(f.descriptors.size, 0);
    });
    for (const field of ['startToken', 'ppid', 'pidNamespace', 'args', 'executable', 'missing']) await t.test(`pending ${field}`, async () => {
        const f = snapshotFixture(); f.rows.delete(20);
        f.add(60, 1, ['node', '/source/roboTeamAgent/server/robot-task.mjs', '--cwd', cwd, '--session-id', 'worker', '--control-stdin']);
        let armed = false;
        f.hook = file => {
            if (file === '/proc/60/exe') armed = true;
            if (!armed || file !== '/proc/60/stat') return;
            armed = false; const row = f.rows.get(60);
            if (field === 'startToken') row.startToken += '1'; if (field === 'ppid') row.ppid = 999;
            if (field === 'pidNamespace') row.pidNamespace = 'pid:[999]'; if (field === 'args') row.args.push('--changed');
            if (field === 'executable') row.executable = '/usr/bin/nodejs'; if (field === 'missing') f.rows.delete(60);
        };
        await assert.rejects(collectNativeProcessSnapshot(10, native, cwd, f.io, selectionFor('census')));
    });
});

test('the exported production program rejects malformed PID arguments before accessing proc', async () => {
    for (const value of ['', '0', '1', '-2', '1.5', '2junk', '1e2', 'NaN', '9007199254740992']) {
        await assert.rejects(execute(process.execPath, ['--input-type=module', '--eval', NATIVE_PROCESS_SNAPSHOT_SOURCE,
            '--', value, JSON.stringify(native), cwd], { timeout: 5000, maxBuffer: 65536 }),
        error => /invalid exact (?:init PID argument|process context)/.test(error.stderr));
    }
});

test('Linux executes the exact production program on real sibling-root and descendant processes', {
    skip: process.platform !== 'linux' ? 'requires Linux /proc; pure observer adversarial cases still run' : false,
    timeout: 30_000,
}, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-process-observer-'));
    const selectedCwd = path.join(root, 'selected');
    fs.mkdirSync(selectedCwd);
    const codeRoot = path.join(root, 'code'), alaRoot = path.join(root, 'ala');
    fs.mkdirSync(path.join(codeRoot, 'server'), { recursive: true }); fs.mkdirSync(path.join(alaRoot, 'bin'), { recursive: true });
    const script = path.join(root, 'native.mjs'), alaScript = path.join(alaRoot, 'bin', 'ala.mjs');
    fs.writeFileSync(script, "setInterval(() => {}, 1000);\n");
    fs.writeFileSync(alaScript, `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [process.argv[2]], { stdio: 'ignore' });
process.send({ pid: child.pid });
process.on('message', () => child.kill('SIGTERM'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', () => process.exit(0));\n`);
    const producerScript = path.join(codeRoot, 'server', 'robot-cli.mjs');
    fs.writeFileSync(producerScript, `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,[${JSON.stringify(alaScript)},${JSON.stringify(script)},'--cwd',${JSON.stringify(selectedCwd)},'--session-id','observer-session','--turn-id','observer-turn','--control-stdin'],{stdio:['ignore','ignore','ignore','ipc']});
child.on('message',message=>process.send({...message,ala:child.pid}));
const stop=()=>child.send('stop');process.on('message',stop);process.on('SIGTERM',stop);child.on('exit',()=>process.exit(0));`);
    const children = [];
    t.after(async () => {
        // Exact process handles only; never use name, broad PID or group kills.
        const ala = children.at(-1);
        if (ala?.connected) ala.send('stop');
        await Promise.all(children.map(async child => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = once(child, 'exit');
            child.kill('SIGTERM');
            await exited;
        }));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const init = spawn(process.execPath, [script], { stdio: 'ignore' });
    children.push(init);
    const unrelated = spawn(process.execPath, [script], { stdio: 'ignore' });
    children.push(unrelated);
    const producer = spawn(process.execPath, [producerScript, '--dir', selectedCwd], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.push(producer);
    const [message] = await once(producer, 'message');
    const frozen = { realpath: script, sha256: crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex') };
    const selection = { kind: 'copilot', codeRoot, sessionId: 'observer-session', turnId: 'observer-turn',
        alaBinding: { root: alaRoot, command: alaScript, hashes: { 'bin/ala.mjs': crypto.createHash('sha256').update(fs.readFileSync(alaScript)).digest('hex') } } };
    const run = source => execute(process.execPath, ['--input-type=module', '--eval', source,
        String(init.pid), JSON.stringify(frozen), selectedCwd, JSON.stringify(selection)], { timeout: 10_000, maxBuffer: 65536 });
    const first = JSON.parse((await run(NATIVE_PROCESS_SNAPSHOT_SOURCE)).stdout);
    assertNativeProcessIdentity(first, frozen, { initPid: init.pid, cwd: selectedCwd,
        ...selection });
    assert.equal(first.ala.pid, message.ala);
    assert.equal(first.ala.ppid, producer.pid);
    assert.notEqual(first.ala.ppid, init.pid, 'the selected init is a sibling, never an ancestor');
    assert.equal(first.native.pid, message.pid);
    assert.deepEqual(JSON.parse((await run(NATIVE_PROCESS_SNAPSHOT_SOURCE)).stdout), first);
    t.diagnostic(`observer-only topology init=${init.pid} ala=${message.ala} native=${message.pid}; no provider or coding-agent execution`);
});

test('Linux selects two observed same-cwd workers by exact deployed producer and IDs using the exported program', {
    skip: process.platform !== 'linux' ? 'requires Linux /proc and neutral subprocess ancestry' : false,
    timeout: 30000,
}, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-process-workers-'));
    const selectedCwd = path.join(root, 'selected'), codeRoot = path.join(root, 'code'), workflowCodeRoot = path.join(root, 'source', 'roboTeamAgent');
    fs.mkdirSync(selectedCwd); fs.mkdirSync(path.join(codeRoot, 'server'), { recursive: true });
    fs.mkdirSync(path.join(workflowCodeRoot, 'server'), { recursive: true });
    const alaRoot = path.join(root, 'ala'); fs.mkdirSync(path.join(alaRoot, 'bin'), { recursive: true });
    const script = path.join(root, 'native.mjs'), alaScript = path.join(alaRoot, 'bin', 'ala.mjs');
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    fs.writeFileSync(alaScript, `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,[${JSON.stringify(script)}],{stdio:'ignore'});
process.send({ala:process.pid,native:child.pid});
const stop=()=>child.kill('SIGTERM'); process.on('message',stop); process.on('SIGTERM',stop);
child.on('exit',()=>process.exit(0));`);
    for (const [kind, filename] of [['copilot', 'robot-cli.mjs'], ['workflow', 'robot-task.mjs']]) {
        fs.writeFileSync(path.join(kind === 'copilot' ? codeRoot : workflowCodeRoot, 'server', filename), `import {spawn} from 'node:child_process';
let child=null;
const start=()=>{child=spawn(process.execPath,[${JSON.stringify(alaScript)},'--cwd',${JSON.stringify(selectedCwd)},'--session-id','${kind}-session','--turn-id','${kind}-turn','--control-stdin'],{stdio:['ignore','ignore','ignore','ipc']});
child.on('message',message=>process.send(message));child.on('exit',()=>{child=null;if('${kind}'==='copilot')process.exit(0);else process.send({retired:true});});};
const stop=()=>{if(child){child.once('exit',()=>process.exit(0));child.send('stop');}else process.exit(0);};
process.on('message',action=>{if(action==='start')start();else if(action==='retire-child')child.send('stop');else stop();});process.on('SIGTERM',stop);
if('${kind}'==='copilot')start();else process.send({ready:true});`);
    }
    const children = [];
    t.after(async () => {
        for (const child of children) if (child.connected) child.send('stop');
        await Promise.all(children.map(async child => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
        }));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const init = spawn(process.execPath, [script], { stdio: 'ignore' }); children.push(init);
    const observed = {};
    for (const [kind, filename, args] of [['copilot', 'robot-cli.mjs', ['--dir', selectedCwd]],
        ['workflow', 'robot-task.mjs', ['--cwd', selectedCwd, '--session-id', 'workflow-session', '--control-stdin']]]) {
        const producer = spawn(process.execPath, [path.join(kind === 'copilot' ? codeRoot : workflowCodeRoot, 'server', filename), ...args], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        children.push(producer);
        const [message] = await once(producer, 'message'); observed[kind] = { ...message, producer: producer.pid };
    }
    const frozen = { realpath: script, sha256: crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex') };
    const alaBinding = { root: alaRoot, command: alaScript, hashes: { 'bin/ala.mjs': crypto.createHash('sha256').update(fs.readFileSync(alaScript)).digest('hex') } };
    const run = (source, selection) => execute(process.execPath, ['--input-type=module', '--eval', source,
        String(init.pid), JSON.stringify(frozen), selectedCwd, JSON.stringify(selection)], { timeout: 10000, maxBuffer: 65536 });
    const censusSelection = { kind: 'census', codeRoot, workflowCodeRoot, alaBinding };
    const beforeChild = JSON.parse((await run(NATIVE_PROCESS_SNAPSHOT_SOURCE, censusSelection)).stdout);
    assert.deepEqual(beforeChild.map(row => row.kind).sort(), ['ala-turn', 'producer-pending']);
    assertNativeProcessCensus(beforeChild, { cwd: selectedCwd, ...censusSelection });
    await assert.rejects(run(NATIVE_PROCESS_SNAPSHOT_SOURCE, { ...censusSelection, kind: 'workflow', sessionId: 'workflow-session', turnId: 'workflow-turn' }),
        error => error.stderr.includes('expected exactly one selected native-turn parent'));
    const workflowProducer = children.at(-1), started = once(workflowProducer, 'message'); workflowProducer.send('start');
    const [workflowMessage] = await started; observed.workflow = { ...workflowMessage, producer: workflowProducer.pid };
    for (const kind of ['copilot', 'workflow']) {
        const selection = { kind, sessionId: `${kind}-session`, turnId: `${kind}-turn`, codeRoot, workflowCodeRoot, alaBinding };
        const first = JSON.parse((await run(NATIVE_PROCESS_SNAPSHOT_SOURCE, selection)).stdout);
        assertNativeProcessIdentity(first, frozen, { initPid: init.pid, cwd: selectedCwd, ...selection });
        assert.equal(first.ala.pid, observed[kind].ala); assert.equal(first.native.pid, observed[kind].native);
        assert.equal(first.producer.pid, observed[kind].producer);
        assert.deepEqual(JSON.parse((await run(NATIVE_PROCESS_SNAPSHOT_SOURCE, selection)).stdout), first);
    }
    const census = JSON.parse((await run(NATIVE_PROCESS_SNAPSHOT_SOURCE, censusSelection)).stdout);
    assert.equal(census.length, 2); assert.ok(census.every(row => row.kind === 'ala-turn'));
    const baselinePath = process.env.LIVE_SESSIONS_BASELINE_SNAPSHOT;
    if (baselinePath) {
        const baseline = fs.readFileSync(baselinePath, 'utf8');
        await assert.rejects(run(baseline, null), error => /expected exactly one selected native-turn parent|invalid required native-turn arguments/.test(error.stderr));
        t.diagnostic(`verbatim baseline sha256=${crypto.createHash('sha256').update(baseline).digest('hex')} rejects actual same-cwd topology with the canonical wrapper control flag`);
    }
    const retired = once(workflowProducer, 'message'); workflowProducer.send('retire-child');
    assert.equal((await retired)[0].retired, true);
    const afterChild = JSON.parse((await run(NATIVE_PROCESS_SNAPSHOT_SOURCE, censusSelection)).stdout);
    assert.deepEqual(afterChild.map(row => row.kind).sort(), ['ala-turn', 'producer-pending']);
    assertNativeProcessCensus(afterChild, { cwd: selectedCwd, ...censusSelection });
    await Promise.all(children.slice(1).map(async child => { const exit = once(child, 'exit'); child.send('stop'); await exit; }));
    assert.deepEqual(JSON.parse((await run(NATIVE_PROCESS_SNAPSHOT_SOURCE, censusSelection)).stdout), []);
});
