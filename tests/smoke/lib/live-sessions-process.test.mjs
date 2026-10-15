import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import test from 'node:test';
import { collectNativeProcessSnapshot, NATIVE_PROCESS_SNAPSHOT_SOURCE, assertNativeProcessIdentity } from './live-sessions.mjs';

const execute = promisify(execFile);
const cwd = '/workspace/selected';
const bytes = Buffer.from('public native fixture');
const native = { realpath: '/public/native', sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
const turnArgs = ['node', '/public/ala.mjs', '--cwd', cwd, '--session-id', 'session', '--turn-id', 'turn', '--control-stdin'];

// This is process metadata, not a second scanner. The production algorithm
// receives only fs-shaped operations; it still performs all parsing/selection.
function snapshotFixture() {
    const rows = new Map();
    const add = (pid, ppid, args, extra = {}) => rows.set(pid, {
        pid, ppid, startToken: String(pid + 100), pidNamespace: 'pid:[100]', args,
        executable: '/usr/bin/node', state: 'S', ...extra,
    });
    add(10, 1, ['init']);
    add(20, 1, [...turnArgs]); // Same namespace, intentionally no init ancestry.
    add(21, 20, ['bwrap'], { executable: '/usr/bin/bwrap' });
    add(22, 21, [native.realpath], { executable: native.realpath, pidNamespace: 'pid:[200]' });
    add(30, 1, [native.realpath], { executable: native.realpath }); // Unrelated same binary.
    const calls = new Map(), descriptors = new Map();
    let nextFd = 1;
    const fixture = { rows, add, calls, hook: null, fileBytes: bytes, inventory: null };
    function access(file) {
        const count = (calls.get(file) || 0) + 1;
        calls.set(file, count);
        fixture.hook?.(file, count);
        const match = file.match(/^\/proc\/([1-9][0-9]*)\/(stat|cmdline|ns\/pid|exe|root\/public\/native)$/);
        assert.ok(match, 'observer must access only metadata and the selected public executable');
        const row = rows.get(Number(match[1]));
        if (!row) throw Object.assign(new Error('fixture process absent'), { code: 'ENOENT' });
        const kind = match[2];
        if (kind === 'ns/pid') return row.pidNamespace;
        if (kind === 'exe') return row.executable;
        if (kind === 'root/public/native') return fixture.fileBytes;
        if (kind === 'cmdline') return row.rawCmdline ?? Buffer.from(row.args.join('\0') + '\0');
        const fields = [row.state, String(row.ppid), ...Array(17).fill('0'), row.startToken];
        return row.rawStat ?? Buffer.from(`${row.pid} (fixture process) ${fields.join(' ')}\n`);
    }
    fixture.io = {
        readdirSync(file) { assert.equal(file, '/proc'); return fixture.inventory ?? [...rows.keys()].map(String); },
        readlinkSync: access,
        openSync(file) {
            const value = access(file);
            assert.ok(Buffer.isBuffer(value));
            const fd = nextFd++;
            descriptors.set(fd, { value, offset: 0 });
            return fd;
        },
        readSync(fd, buffer, offset, length) {
            const descriptor = descriptors.get(fd);
            const size = Math.min(length, descriptor.value.length - descriptor.offset);
            descriptor.value.copy(buffer, offset, descriptor.offset, descriptor.offset + size);
            descriptor.offset += size;
            return size;
        },
        fstatSync(fd) { return { isFile: () => true, size: descriptors.get(fd).value.length }; },
        closeSync(fd) { assert.equal(descriptors.delete(fd), true); },
    };
    fixture.observe = (rootPid = 10, selectedCwd = cwd) => collectNativeProcessSnapshot(rootPid, native, selectedCwd, fixture.io);
    return fixture;
}

test('same namespace selects a non-init-descendant ALA and preserves the entire native ancestry', async () => {
    const fixture = snapshotFixture();
    const first = await fixture.observe();
    assertNativeProcessIdentity(first, native, { initPid: 10, cwd, sessionId: 'session', turnId: 'turn' });
    assert.equal(first.ala.ppid, 1);
    assert.equal(first.native.pidNamespace, 'pid:[200]', 'the native sandbox may unshare its PID namespace');
    assert.deepEqual(first.ancestry.map(row => row.pid), [22, 21]);
    assert.equal(first.native.pid, 22, 'unrelated same binary and Bubblewrap are excluded');
    assert.deepEqual(await fixture.observe(), first);
    assert.equal(fixture.rows.size, 5, 'observation creates no execution');
});

test('native script matching accepts only the exact script position of a supported interpreter', async () => {
    const fixture = snapshotFixture();
    const row = fixture.rows.get(22);
    row.executable = '/usr/bin/node';
    row.args = ['/usr/bin/node', native.realpath];
    const identity = await fixture.observe();
    assert.equal(identity.native.scriptPath, native.realpath);
    assertNativeProcessIdentity(identity, native, { initPid: 10, cwd });
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
    const script = path.join(root, 'native.mjs'), alaScript = path.join(root, 'ala.mjs');
    fs.writeFileSync(script, "setInterval(() => {}, 1000);\n");
    fs.writeFileSync(alaScript, `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [process.argv[2]], { stdio: 'ignore' });
process.send({ pid: child.pid });
process.on('message', () => child.kill('SIGTERM'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', () => process.exit(0));\n`);
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
    const ala = spawn(process.execPath, [alaScript, script, '--cwd', selectedCwd, '--session-id', 'observer-session',
        '--turn-id', 'observer-turn', '--control-stdin'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.push(ala);
    const [message] = await once(ala, 'message');
    const frozen = { realpath: script, sha256: crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex') };
    const run = source => execute(process.execPath, ['--input-type=module', '--eval', source,
        String(init.pid), JSON.stringify(frozen), selectedCwd], { timeout: 10_000, maxBuffer: 65536 });
    const first = JSON.parse((await run(NATIVE_PROCESS_SNAPSHOT_SOURCE)).stdout);
    assertNativeProcessIdentity(first, frozen, { initPid: init.pid, cwd: selectedCwd,
        sessionId: 'observer-session', turnId: 'observer-turn' });
    assert.equal(first.ala.pid, ala.pid);
    assert.equal(first.ala.ppid, process.pid);
    assert.notEqual(first.ala.ppid, init.pid, 'the selected init is a sibling, never an ancestor');
    assert.equal(first.native.pid, message.pid);
    assert.deepEqual(JSON.parse((await run(NATIVE_PROCESS_SNAPSHOT_SOURCE)).stdout), first);
    const baselinePath = process.env.LIVE_SESSIONS_BASELINE_SNAPSHOT;
    if (baselinePath) {
        // Optional verifier evidence only. Routine unit tests have no Git or
        // historical-source dependency; the extracted program is run verbatim.
        const baseline = fs.readFileSync(baselinePath, 'utf8');
        await assert.rejects(execute(process.execPath, ['--input-type=module', '--eval', baseline,
            String(init.pid), JSON.stringify(frozen), path.basename(selectedCwd)], { timeout: 10_000, maxBuffer: 65536 }),
        error => error.stderr.includes('expected exactly one selected native-turn parent'));
        t.diagnostic(`baseline sha256=${crypto.createHash('sha256').update(baseline).digest('hex')} rejected its actual parent-selection error`);
    }
    t.diagnostic(`observer-only topology init=${init.pid} ala=${ala.pid} native=${message.pid}; no provider or coding-agent execution`);
});
