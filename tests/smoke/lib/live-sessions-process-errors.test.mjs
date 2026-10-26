import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { normalizeNativeProcessError, nativeProcessIdentity } from './live-sessions.mjs';
import { createLiveSessionFinalizer, projectLiveSessionError } from './live-sessions-diagnostics.mjs';
import { findTraceCredentialResidue } from './redacted-trace.mjs';

const execute = promisify(execFile);
async function rejected(command, args, options = {}) {
    try { await execute(command, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 65536, ...options }); }
    catch (error) { return error; }
    assert.fail('The real subprocess must reject.');
}

test('real long-eval exit loses baseline stderr but production normalization preserves it through finalization', async () => {
    const marker = `NATIVE_ASSERTION_${randomUUID()}`, sourceCanary = 'native-eval-command-canary';
    const source = `/* ${sourceCanary} ${'x'.repeat(10000)} */process.stderr.write(${JSON.stringify(marker)});process.exit(17);`;
    const raw = await rejected(process.execPath, ['--input-type=module', '--eval', source]);
    assert.equal(raw.code, 17); assert.equal(raw.stderr, marker); assert.ok(Buffer.byteLength(source) > 8192);
    assert.ok(!JSON.stringify(projectLiveSessionError(raw, { env: {} })).includes(marker));
    const normalized = normalizeNativeProcessError(raw, { env: {} });
    assert.equal(normalized.name, 'NativeProcessEvidenceError'); assert.equal(normalized.code, 17);
    assert.equal(normalized.stderr, marker); assert.notEqual(normalized.cause, raw);
    assert.equal(Object.getOwnPropertyDescriptor(normalized, 'stack'), undefined);
    for (const key of ['cmd', 'stdout', 'errors']) assert.equal(Object.getOwnPropertyDescriptor(normalized, key), undefined);
    let attachment;
    await assert.rejects(createLiveSessionFinalizer({ env: {} }).finish({ attach(_name, args) { attachment = args.body.toString(); } }, normalized), error => {
        assert.ok(error.message.includes(marker)); assert.ok(error.message.includes('code=17'));
        assert.ok(!error.message.includes(sourceCanary)); return true;
    });
    assert.ok(attachment.includes(marker)); assert.ok(attachment.includes('code=17')); assert.ok(!attachment.includes(sourceCanary));
    assert.match(nativeProcessIdentity.toString(), /\.catch\(error => \{ throw normalizeNativeProcessError\(error\); \}\)/);
});

test('stderr availability and 128 KiB input bounds distinguish strings and copied Buffers', () => {
    for (const value of [undefined, null, 17, {}, ['private-unsupported-value']]) {
        assert.equal(normalizeNativeProcessError({ stderr: value }, { env: {} }).stderr, '[stderr unavailable]');
    }
    for (const value of ['', Buffer.alloc(0)]) assert.equal(normalizeNativeProcessError({ stderr: value }, { env: {} }).stderr, '[stderr empty]');
    for (const value of ['x'.repeat(128 * 1024 + 1), Buffer.alloc(128 * 1024 + 1), '雪'.repeat(50000)]) {
        assert.equal(normalizeNativeProcessError({ stderr: value }, { env: {} }).stderr, '[stderr omitted: input exceeds 128 KiB]');
    }
    const exactly = 'h'.repeat(512) + 'x'.repeat(128 * 1024 - 517) + 'TAIL!';
    for (const value of [exactly, Buffer.from(exactly)]) {
        const safe = normalizeNativeProcessError({ stderr: value }, { env: {} });
        assert.equal(Buffer.byteLength(safe.stderr), 4096); assert.ok(safe.stderr.startsWith('h'.repeat(512)));
        assert.ok(safe.stderr.endsWith('TAIL!')); assert.match(safe.stderr, /middle omitted/);
    }
});

test('UTF-8 head and terminal tail stay well formed and within 4096 actual bytes', () => {
    for (const offset of [0, 1, 2, 3]) for (const glyph of ['雪', '🙂']) {
        const text = 'h'.repeat(offset) + glyph.repeat(5000) + 'TERMINAL_ASSERTION';
        const safe = normalizeNativeProcessError({ stderr: text }, { env: {} }).stderr;
        assert.ok(Buffer.byteLength(safe) <= 4096); assert.equal(safe.isWellFormed(), true);
        assert.ok(!safe.includes('\ufffd')); assert.ok(safe.endsWith('TERMINAL_ASSERTION'));
        assert.ok(Buffer.from(safe).equals(Buffer.from(Buffer.from(safe).toString('utf8'))));
    }
    assert.equal(normalizeNativeProcessError({ stderr: Buffer.from([0xff]) }, { env: {} }).stderr, '\ufffd');
});

test('configured and lexical secrets redact before head/tail cuts with no surviving fragments or residue', () => {
    const secret = 'native-process-private-secret-abcdefghijklmnopqrstuvwxyz';
    for (const start of [490, 505, 512, 6000, 6400]) {
        const text = 'h'.repeat(start) + secret + '\n' + 'm'.repeat(6000) + secret + '\n' +
            'authorization: Bearer lexical-private-canary\npassword=private-form-canary\n' +
            'eyJfixturevalue.fixturepayload.fixturesignature\nTERMINAL_ASSERTION';
        const safe = normalizeNativeProcessError({ stderr: text }, { env: { FIXTURE_SECRET: secret } });
        for (const forbidden of [secret, 'native-process-private', 'lexical-private-canary', 'private-form-canary', 'fixturepayload']) {
            assert.ok(!JSON.stringify(safe).includes(forbidden));
        }
        assert.ok(safe.stderr.endsWith('TERMINAL_ASSERTION')); assert.ok(Buffer.byteLength(safe.stderr) <= 4096);
        assert.deepEqual(findTraceCredentialResidue(safe.stderr), []);
    }
    const inaccessibleEnv = new Proxy({}, { ownKeys() { throw new Error('private environment failure'); } });
    assert.equal(normalizeNativeProcessError({ stderr: 'must be withheld' }, { env: inaccessibleEnv }).stderr, '[REDACTED:RESIDUE]');
    const terminal = 'TERMINAL_ASSERTION', total = 12000;
    const tailStart = total - (4096 - 512 - Buffer.byteLength('\n[stderr middle omitted]\n'));
    const prefix = 'h'.repeat(tailStart - 20);
    const acrossTail = prefix + secret + 'm'.repeat(total - prefix.length - secret.length - terminal.length) + terminal;
    const safeTail = normalizeNativeProcessError({ stderr: acrossTail }, { env: { FIXTURE_SECRET: secret } }).stderr;
    assert.ok(!safeTail.includes('abcdefghijklmnopqrstuvwxyz')); assert.ok(!safeTail.includes('native-process-private'));
    assert.ok(safeTail.endsWith(terminal)); assert.ok(Buffer.byteLength(safeTail) <= 4096);
    const statusSecret = normalizeNativeProcessError({ code: 'ERR_PRIVATE_STATUS_VALUE', signal: 'SIGPRIVATE', stderr: 'safe terminal assertion' },
        { env: { FIXTURE_SECRET: 'PRIVATE_STATUS_VALUE', OTHER_TOKEN: 'SIGPRIVATE' } });
    assert.equal(statusSecret.code, 'unavailable'); assert.equal(statusSecret.signal, 'unavailable');
    assert.ok(!JSON.stringify(statusSecret).includes('PRIVATE_STATUS_VALUE')); assert.ok(!JSON.stringify(statusSecret).includes('SIGPRIVATE'));
});

test('only validated status primitives survive; hostile own/inherited getters and conversions remain untouched', () => {
    let getters = 0;
    const hostile = Object.create(Object.defineProperty({}, 'stderr', { get() { getters += 1; return 'inherited private stderr'; } }));
    for (const key of ['message', 'stack', 'cmd', 'stdout', 'cause', 'errors', 'stderr', 'code', 'signal', 'killed', 'toString']) {
        Object.defineProperty(hostile, key, { get() { getters += 1; throw new Error('private getter'); } });
    }
    const safe = normalizeNativeProcessError(hostile, { env: {} });
    assert.equal(getters, 0); assert.equal(safe.code, 'unavailable'); assert.equal(safe.signal, 'unavailable'); assert.equal(safe.killed, 'unavailable');
    assert.equal(safe.stderr, '[stderr unavailable]');
    const unsupported = { toString() { getters += 1; throw new Error('converted'); }, valueOf() { getters += 1; throw new Error('converted'); } };
    for (const value of [unsupported, null, true, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'bad-code', 'X'.repeat(65)]) {
        assert.equal(normalizeNativeProcessError({ code: value, signal: value, killed: value, stderr: unsupported }, { env: {} }).code, 'unavailable');
    }
    for (const code of [0, 17, -1, Number.MAX_SAFE_INTEGER, 'ENOENT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']) {
        assert.equal(normalizeNativeProcessError({ code }, { env: {} }).code, code);
    }
    for (const signal of ['SIGTERM', 'SIGKILL', 'SIGUSR1']) assert.equal(normalizeNativeProcessError({ signal }, { env: {} }).signal, signal);
    for (const signal of ['TERM', 'SIGTERM\nprivate', 'SIG' + 'X'.repeat(31), 17, unsupported]) {
        assert.equal(normalizeNativeProcessError({ signal }, { env: {} }).signal, 'unavailable');
    }
    for (const killed of [true, false]) assert.equal(normalizeNativeProcessError({ killed }, { env: {} }).killed, killed);
    assert.equal(getters, 0);
    const env = Object.defineProperty({}, 'FIXTURE_SECRET', { get() { getters += 1; throw new Error('environment getter'); } });
    assert.equal(normalizeNativeProcessError({ stderr: 'safe stderr' }, { env }).stderr, 'safe stderr'); assert.equal(getters, 0);
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private descriptor trap'); } });
    assert.equal(normalizeNativeProcessError(proxy, { env: {} }).stderr, '[stderr unavailable]');
});

test('Buffer copying bypasses caller methods and repeated normalization retains only safe own data', () => {
    let accessed = 0;
    const raw = Buffer.from('buffer stderr marker');
    for (const key of ['toString', 'utf8Slice', 'byteLength', 'length', 'constructor', Symbol.iterator]) {
        Object.defineProperty(raw, key, { get() { accessed += 1; throw new Error('private Buffer conversion'); } });
    }
    const first = normalizeNativeProcessError({ code: 17, signal: 'SIGTERM', killed: true, stderr: raw }, { env: {} });
    assert.equal(first.stderr, 'buffer stderr marker'); assert.equal(accessed, 0);
    assert.deepEqual(normalizeNativeProcessError(first, { env: {} }), first);
    assert.deepEqual(projectLiveSessionError(normalizeNativeProcessError(first, { env: {} })), projectLiveSessionError(first));
});

test('real signal, timeout, spawn and maxBuffer errors retain safe status without raw command data', async () => {
    const signaled = normalizeNativeProcessError(await rejected(process.execPath, ['-e', "process.stderr.write('signal-terminal-marker');process.kill(process.pid,'SIGTERM');"]), { env: {} });
    assert.equal(signaled.signal, 'SIGTERM'); assert.equal(signaled.code, 'unavailable'); assert.match(signaled.stderr, /signal-terminal-marker/);
    const timeout = normalizeNativeProcessError(await rejected(process.execPath, ['-e', "process.stderr.write('timeout-terminal-marker');setInterval(()=>{},1000);"], { timeout: 500 }), { env: {} });
    assert.equal(timeout.killed, true); assert.equal(timeout.signal, 'SIGTERM'); assert.match(timeout.stderr, /timeout-terminal-marker/);
    const spawn = normalizeNativeProcessError(await rejected('/native-observation-missing-command-canary', []), { env: {} });
    assert.equal(spawn.code, 'ENOENT'); assert.ok(!JSON.stringify(spawn).includes('missing-command-canary'));
    const overflow = normalizeNativeProcessError(await rejected(process.execPath, ['-e', "process.stderr.write('x'.repeat(10000));"], { maxBuffer: 1024 }), { env: {} });
    assert.equal(overflow.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'); assert.ok(Buffer.byteLength(overflow.stderr) <= 4096);
});
