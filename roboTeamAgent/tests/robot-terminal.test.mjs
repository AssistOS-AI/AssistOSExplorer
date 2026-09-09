import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { robotTerminalDirectory } from '../server/robot-terminal.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { discoverRobotTerminal, openRobotTerminal } from '../public/terminal.js';

test('terminal resolves the persistent robot home and rejects substituted mounts and symlinks', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-terminal-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new RobotStore({ dataDir: path.join(root, '.data/roboTeamAgent') });
    const robot = await store.create({ name: 'analyst' });
    const expected = `.data/roboTeamAgent/robots/${robot.id}/home`;
    assert.equal(await robotTerminalDirectory(store, robot.id, root), expected);
    const other = path.join(root, 'other');
    await fs.mkdir(other);
    await assert.rejects(robotTerminalDirectory({ robotPath: () => root }, robot.id, root));
    await fs.rename(path.join(root, expected), path.join(root, 'saved-home'));
    await fs.symlink(other, path.join(root, expected));
    await assert.rejects(robotTerminalDirectory(store, robot.id, root), /workspace mount/);
});

function discovery(targets) {
    return { ok: true, discovery: { id: 'd'.repeat(32), directory: 'robot/home', expiresAt: Date.now() + 60000, targets } };
}
const target = { kind: 'agent', detail: 'AchillesCLI/roboTeamAgent', access: 'rw', launch: 'x'.repeat(32) };

test('terminal uses router discovery with only a relative cwd and a fragment-only launch', async () => {
    const calls = [];
    const launch = await discoverRobotTerminal('robot/home', {
        cookie: 'ploinky_browser_csrf=proof',
        fetchImpl: async (...args) => { calls.push(args); return { ok: true, json: async () => discovery([target]) }; },
    });
    assert.equal(launch.url, '/webtty/#launch=' + target.launch);
    assert.equal(calls[0][0], '/webtty/target-discoveries');
    assert.deepEqual(JSON.parse(calls[0][1].body), { dir: 'robot/home' });
    assert.equal(calls[0][1].headers['x-ploinky-browser-csrf-token'], 'proof');
});

test('terminal cancels unusable discoveries rather than falling back to another agent or Box', async () => {
    for (const targets of [[], [{ ...target, kind: 'box' }], [target, target], [{ ...target, access: 'ro' }], [{ ...target, launch: 'https://wrong' }]]) {
        const calls = [];
        await assert.rejects(discoverRobotTerminal('robot/home', { cookie: '', fetchImpl: async (...args) => {
            calls.push(args); return { ok: true, json: async () => discovery(targets) };
        } }), /No unique/);
        assert.equal(calls[1][1].method, 'DELETE');
    }
});

test('startup failures stay visible in the popup and cancel any unused launch', async () => {
    const popup = { opener: {}, document: { body: {} }, close: () => assert.fail('must keep error visible') };
    await assert.rejects(openRobotTerminal({ id: 'robot' }, async () => { throw new Error('home unavailable'); }, {
        windowRef: { open: () => popup },
    }), /home unavailable/);
    assert.equal(popup.document.title, 'Robot terminal could not open');
    assert.match(popup.document.body.textContent, /home unavailable/);
    let cancelled = false;
    popup.closed = true;
    await assert.rejects(openRobotTerminal({ id: 'robot' }, async () => ({ directory: 'robot/home' }), {
        windowRef: { open: () => popup },
        discover: async () => ({ cancel: async () => { cancelled = true; } }),
    }), /window was closed/);
    assert.equal(cancelled, true);
});

test('blocked popups do not allocate a terminal; navigation strips opener and referrer', async () => {
    await assert.rejects(openRobotTerminal({ id: 'robot' }, () => assert.fail('must not request'), {
        windowRef: { open: () => null },
    }), /Allow popups/);
    const anchor = { click() { this.clicked = true; } };
    const popup = { opener: {}, document: { body: { appendChild() {} }, createElement: () => anchor } };
    await openRobotTerminal({ id: 'robot', name: 'Analyst' }, async () => ({ directory: 'robot/home' }), {
        windowRef: { open: () => popup }, discover: async () => ({ url: '/webtty/#launch=' + target.launch }),
    });
    assert.equal(popup.opener, null);
    assert.equal(anchor.referrerPolicy, 'no-referrer');
    assert.equal(anchor.rel, 'noopener noreferrer');
    assert.equal(anchor.clicked, true);
});
