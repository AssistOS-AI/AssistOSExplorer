import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import test from 'node:test';

const source = await fs.readFile(new URL('../scripts/robot-shell.mjs', import.meta.url), 'utf8');
const runSource = source.slice(source.indexOf('async function run('), source.indexOf('\nexport async function main()'));

function fixture(inner = true) {
    const runtime = new EventEmitter(), child = new EventEmitter(), exits = [], timers = new Set(), probes = [];
    let attached = true, spawns = 0;
    runtime.exit = code => exits.push(code);
    // Accessing a stream would consume or alter the shell's input handling.
    Object.defineProperty(runtime, 'stdin', { get() { throw Error('Terminal input must stay untouched'); } });
    const options = { stdio: 'inherit', detached: false };
    const context = { process: runtime, spawn: (_command, _args, passed) => {
        assert.equal(passed, options); spawns++; return child;
    }, isatty: fd => { probes.push(fd); return attached; },
    setInterval: (callback, delay) => { assert.equal(delay, 100); timers.add(callback); return callback; },
    clearInterval: callback => timers.delete(callback) };
    const run = vm.runInNewContext('(' + runSource + ')', context);
    const result = run({ command: 'sandbox', args: [], options }, { inner });
    return { runtime, child, exits, timers, probes, result, spawns: () => spawns,
        hangup: () => { attached = false; }, tick: () => { for (const callback of [...timers]) callback(); } };
}

test('inner TTY hangup exits PID 1 even while a both-signal-ignoring foreground keeps the child alive', () => {
    const f = fixture();
    assert.equal(f.spawns(), 1); assert.equal(f.timers.size, 1);
    f.tick(); assert.deepEqual(f.exits, []);
    // No child exit or signal response occurs; only the inherited TTY hangs up.
    f.hangup(); f.tick();
    assert.deepEqual(f.exits, [129]); assert.ok(f.probes.every(fd => fd === 0));
});

test('inner refuses an already hung-up TTY before launching the sandbox', () => {
    // Initial hangup is covered by the same fresh probe before spawn.
    const runtime = new EventEmitter(), exits = []; let spawned = false;
    runtime.exit = code => exits.push(code);
    const run = vm.runInNewContext('(' + runSource + ')', { process: runtime, isatty: () => false,
        spawn: () => { spawned = true; return new EventEmitter(); }, setInterval: () => assert.fail('No timer after initial hangup') });
    run({ command: 'sandbox', args: [], options: {} }, { inner: true });
    assert.deepEqual(exits, [129]); assert.equal(spawned, false);
});

test('live inner TTY leaves Ctrl-C, Ctrl-Z and resize delivery with the shell and preserves normal exit', async () => {
    const f = fixture(); f.tick();
    assert.equal(f.runtime.listenerCount('SIGINT'), 1); f.runtime.emit('SIGINT');
    assert.equal(f.runtime.listenerCount('SIGQUIT'), 1); f.runtime.emit('SIGQUIT');
    assert.equal(f.runtime.listenerCount('SIGTSTP'), 0); assert.equal(f.runtime.listenerCount('SIGWINCH'), 0);
    assert.deepEqual(f.exits, []);
    f.child.emit('exit', 0, null); assert.equal(await f.result, 0);
    assert.equal(f.timers.size, 0); assert.equal(f.runtime.listenerCount('SIGINT'), 0);
    assert.equal(f.runtime.listenerCount('SIGQUIT'), 0);
});

test('spawn errors dispose the inner watcher and signal listeners', async () => {
    const f = fixture(), error = new Error('spawn failed'); f.child.emit('error', error);
    await assert.rejects(f.result, value => value === error);
    assert.equal(f.timers.size, 0); assert.equal(f.runtime.listenerCount('SIGINT'), 0);
    assert.equal(f.runtime.listenerCount('SIGQUIT'), 0);
});

test('outer launch never probes or watches its TTY and retains signal exit mapping', async () => {
    const f = fixture(false); f.hangup(); f.tick();
    assert.deepEqual(f.probes, []); assert.equal(f.timers.size, 0); assert.deepEqual(f.exits, []);
    f.child.emit('exit', null, 'SIGTERM'); assert.equal(await f.result, 128);
});

test('only the --inner entrypoint opts into TTY hangup detection', () => {
    assert.match(source, /const inner = process\.argv\[2\] === '--inner'/u);
    assert.match(source, /await run\(launch, \{ inner \}\)/u);
});
