import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import test from 'node:test';

import { createPtyHost } from '../../server/terminal/ptyHost.mjs';

// M-8 PTY host over a FAKE node-pty module shaped like node-pty 1.0.0 `open()` (unixTerminal: _master, _slave with its pipe handle fd,
// resize): the slave is paused at once (node-pty resumes it, which would make the worker read the shell's input), the master's EIO is
// handled, the slave copy is closed exactly once, and anything unexpected is sandbox_unavailable (no fallback).

class FakeSocket extends EventEmitter {
    constructor(fd) { super(); this._handle = { fd }; this.paused = false; this.destroyed = 0; this.writes = []; }
    pause() { this.paused = true; }
    resume() { this.paused = false; }
    destroy() { this.destroyed += 1; }
    write(buffer, callback) { this.writes.push(Buffer.from(buffer)); callback?.(null); }
}

function fakeModule() {
    const opened = [];
    return {
        opened,
        open(options) {
            const term = { options, _master: new FakeSocket(40), _slave: new FakeSocket(41), sizes: [], resize(cols, rows) { term.sizes.push([cols, rows]); } };
            term._slave.resume();
            opened.push(term);
            return term;
        }
    };
}

test('open: binary mode, slave paused at once, master EIO handled, input/output counted (never kept), slave closed once, master closed last', () => {
    const module = fakeModule();
    const host = createPtyHost({ moduleDir: os.tmpdir(), load: () => module });
    assert.deepEqual(host.available(), { ok: true });
    const pty = host.open({ cols: 80, rows: 24 });
    const term = module.opened[0];
    assert.deepEqual(term.options, { cols: 80, rows: 24, encoding: null });
    assert.equal(term._slave.paused, true, 'the worker never reads the shell input');
    assert.equal(pty.slaveFd, 41);
    assert.doesNotThrow(() => term._master.emit('error', Object.assign(new Error('read EIO'), { code: 'EIO' })));
    const seen = [];
    pty.onData((chunk) => seen.push(chunk.toString()));
    term._master.emit('data', Buffer.from('hello'));
    assert.deepEqual(seen, ['hello']);
    pty.write(Buffer.from('abc'), (error) => assert.equal(error, null));
    assert.deepEqual(pty.bytes, { input: 3, output: 5 });
    pty.resize(100, 40);
    assert.deepEqual(term.sizes, [[100, 40]]);
    pty.destroySlave();
    pty.destroySlave();
    assert.equal(term._slave.destroyed, 1);
    pty.close();
    pty.close();
    assert.equal(term._master.destroyed, 1);
    pty.write(Buffer.from('late'), (error) => assert.equal(error.code, 'closed'));
});

test('a missing module, a load error or an open() result without the expected shape is sandbox_unavailable', () => {
    assert.deepEqual(createPtyHost({ moduleDir: '/nonexistent/node-pty' }).available(), { ok: false, code: 'sandbox_unavailable' });
    assert.deepEqual(createPtyHost({ moduleDir: os.tmpdir(), load: () => { throw new Error('ABI'); } }).available(), { ok: false, code: 'sandbox_unavailable' });
    const shapeless = createPtyHost({ moduleDir: os.tmpdir(), load: () => ({ open: () => ({ _master: new FakeSocket(40) }) }) });
    assert.throws(() => shapeless.open({ cols: 80, rows: 24 }), (error) => error.code === 'sandbox_unavailable');
    const slaveWithoutFd = createPtyHost({ moduleDir: os.tmpdir(), load: () => ({ open: () => ({ _master: new FakeSocket(40), _slave: Object.assign(new FakeSocket(null), { _handle: {} }), resize() {} }) }) });
    assert.throws(() => slaveWithoutFd.open({ cols: 80, rows: 24 }), (error) => error.code === 'sandbox_unavailable');
});

test('review #4: output before the first subscriber is held (bounded: the master pauses) and handed to it in order', () => {
    const module = fakeModule();
    const pty = createPtyHost({ moduleDir: os.tmpdir(), load: () => module }).open({ cols: 80, rows: 24 });
    const term = module.opened[0];
    term._master.emit('data', Buffer.from('a'));
    term._master.emit('data', Buffer.alloc(256 * 1024, 98));
    assert.equal(term._master.paused, true, 'paused at the bound until a subscriber exists');
    const seen = [];
    pty.onData((chunk) => seen.push(chunk.length));
    assert.deepEqual(seen, [1, 256 * 1024]);
    assert.equal(term._master.paused, false);
    term._master.emit('data', Buffer.from('c'));
    assert.deepEqual(seen, [1, 256 * 1024, 1]);
});
