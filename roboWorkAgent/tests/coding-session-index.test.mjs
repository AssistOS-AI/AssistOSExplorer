import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodingSessionIndex } from '../server/coding-session-index.mjs';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-index-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    let time = 100000;
    const calls = [], rows = new Map(), failures = new Set(), timers = [];
    const robots = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }];
    const config = { root, defer: (callback, ms) => { timers.push({ callback, ms }); return null; }, ensureDirectory: async () => {}, robots: async () => robots, agents: ['vibe', 'opencode'],
        now: () => time, history: async (robot, agent, directory) => {
            calls.push([robot, agent, directory]);
            if (failures.has(`${robot}/${agent}`)) throw new Error('helper unavailable');
            return rows.get(`${robot}/${agent}`) || [];
        } };
    return { root, calls, rows, failures, robots, config, timers, tick: ms => timers.filter(timer => timer.ms === ms).at(-1).callback(), advance: (ms = 61000) => { time += ms; }, index: createCodingSessionIndex(config) };
}

test('first import is asynchronous, deduplicated and persists even an empty folder across restart', async t => {
    const f = await fixture(t);
    const first = await f.index.list('project');
    assert.equal(first.refreshing, true);
    await f.index.list('project');
    await f.index.idle();
    assert.equal(f.calls.length, 4);
    assert.deepEqual((await f.index.list('project')).sessions, []);
    const restarted = createCodingSessionIndex(f.config);
    assert.equal((await restarted.list('project')).refreshing, false);
    assert.equal(f.calls.length, 4);
    f.advance();
    await restarted.list('project'); await restarted.idle();
    assert.equal(f.calls.length, 4, 'empty catalogs are not scanned again');
});

test('robot, agent, folder and native ID associations survive restart and failed updates', async t => {
    const f = await fixture(t);
    f.rows.set('a/vibe', [{ id: 'same', title: 'Alpha conversation' }]);
    f.rows.set('b/opencode', [{ id: 'same', title: 'Beta conversation' }]);
    await f.index.list('project'); await f.index.idle();
    const restarted = createCodingSessionIndex(f.config);
    const listed = await restarted.list('project');
    const reconcile = f.timers.at(-1).callback;
    assert.deepEqual(listed.sessions.map(row => [row.robotId, row.codingAgent, row.id]), [['a', 'vibe', 'same'], ['b', 'opencode', 'same']]);
    assert.deepEqual((await restarted.list('different')).sessions, []);
    await restarted.idle();
    f.failures.add('a/vibe'); f.advance();
    reconcile();
    await restarted.list('project'); await restarted.idle();
    const failed = await restarted.list('project');
    assert.equal(failed.sessions.length, 2);
    assert.deepEqual(failed.errors, ['Alpha / vibe']);
    f.rows.set('b/opencode', []); f.failures.clear();
    f.advance(); reconcile();
    await restarted.idle();
    assert.equal((await restarted.list('project')).sessions.length, 2, 'an empty or partial native catalog cannot erase indexed conversations');
});

test('launches register new sources while history reads update rows without importing other catalogs', async t => {
    const f = await fixture(t);
    await f.index.list('project'); await f.index.idle();
    f.calls.length = 0;
    await f.index.launched('project', f.robots[1], 'opencode');
    f.rows.set('b/opencode', [{ id: 'new-id', title: 'New' }]);
    f.tick(2000);
    await f.index.list('project'); await f.index.idle();
    assert.deepEqual(f.calls, [['b', 'opencode', 'project']]);
    await f.index.record('project', f.robots[0], 'vibe', [{ id: 'cli-id', title: 'CLI' }]);
    assert.equal((await f.index.list('project')).sessions.length, 2);
    f.rows.set('a/vibe', [{ id: 'cli-id', title: 'CLI' }]);
    f.robots.splice(1, 1); f.advance(); f.tick(900000);
    await f.index.list('project'); await f.index.idle();
    assert.deepEqual((await f.index.list('project')).sessions.map(row => row.robotId), ['a']);
});

test('an index read returns while its native history reader is blocked', async t => {
    const f = await fixture(t);
    let release;
    const index = createCodingSessionIndex({ ...f.config, history: () => new Promise(resolve => { release = () => resolve([]); }), agents: ['vibe'], robots: async () => [f.robots[0]] });
    const result = await index.list('project');
    assert.equal(result.refreshing, true);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await index.list('project')).refreshing, true);
    release(); await index.idle();
});

test('symlinked and corrupt index files are refused rather than overwritten', async t => {
    const f = await fixture(t);
    await f.index.list('project'); await f.index.idle();
    const file = path.join(f.root, (await fs.readdir(f.root)).find(name => name.endsWith('.json')));
    await fs.writeFile(file, 'invalid');
    await assert.rejects(f.index.list('project'));
    const outside = path.join(f.root, 'outside');
    await fs.writeFile(outside, 'unchanged'); await fs.rm(file); await fs.symlink(outside, file);
    await assert.rejects(f.index.list('project'));
    assert.equal(await fs.readFile(outside, 'utf8'), 'unchanged');
});

test('post-launch updates discover native IDs without an open browser or CLI', async t => {
    const f = await fixture(t);
    const callbacks = [];
    const index = createCodingSessionIndex({ ...f.config, defer: (callback, ms) => { callbacks.push({ callback, ms }); return null; } });
    await index.list('project'); await index.idle();
    await index.launched('project', f.robots[0], 'vibe');
    assert.deepEqual(callbacks.filter(entry => entry.ms < 900000).map(entry => entry.ms), [2000, 30000, 120000]);
    f.rows.set('a/vibe', [{ id: 'native-created-later', title: 'Native title' }]);
    f.calls.length = 0;
    callbacks.find(entry => entry.ms === 2000).callback(); await index.idle();
    const restarted = createCodingSessionIndex(f.config);
    const listed = await restarted.list('project');
    assert.equal(listed.sessions[0].id, 'native-created-later');
    assert.equal(listed.refreshing, false);
    assert.deepEqual(f.calls, [['a', 'vibe', 'project']]);
});


test('periodic reconciliation discovers external conversations in previously empty catalogs', async t => {
    const f = await fixture(t);
    const callbacks = [];
    const index = createCodingSessionIndex({ ...f.config, defer: (callback, ms) => { callbacks.push({ callback, ms }); return null; } });
    await index.list('project'); await index.idle();
    f.rows.set('b/vibe', [{ id: 'external', title: 'Created outside Ploinky' }]);
    f.advance(15 * 60000);
    callbacks.find(entry => entry.ms === 900000).callback();
    await index.idle();
    assert.equal((await index.list('project')).sessions[0].id, 'external');
});


test('opening an old index reads saved rows without starting a native scan', async t => {
    const f = await fixture(t);
    await f.index.list('project'); await f.index.idle();
    f.calls.length = 0;
    f.advance(3600000);
    const restarted = createCodingSessionIndex(f.config);
    for (let i = 0; i < 10; i++) assert.equal((await restarted.list('project')).refreshing, false);
    await restarted.idle();
    assert.equal(f.calls.length, 0);
});
