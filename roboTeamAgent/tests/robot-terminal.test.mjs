import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listTerminalProfiles, resolveTerminalProfile, robotTerminalDirectory, robotTerminalHome, terminalProfileAccess } from '../server/robot-terminal.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { discoverRobotTerminal, openRobotTerminal } from '../public/terminal.js';

test('terminal resolves the persistent robot home and rejects substituted mounts and symlinks', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-terminal-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new RobotStore({ dataDir: path.join(root, '.data/roboTeamAgent') });
    const robot = await store.create({ name: 'analyst' });
    const expected = `.data/roboTeamAgent/robots/${robot.id}`;
    assert.equal(await robotTerminalDirectory(store, robot.id, root), expected);
    const other = path.join(root, 'other');
    await fs.mkdir(other);
    await assert.rejects(robotTerminalDirectory({ robotPath: () => root }, robot.id, root));
    await fs.rename(path.join(root, expected), path.join(root, 'saved-home'));
    await fs.symlink(other, path.join(root, expected));
    await assert.rejects(robotTerminalDirectory(store, robot.id, root), /workspace mount/);
});

async function treeSnapshot(directory) {
    const entries = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true, recursive: true })) {
        const full = path.join(entry.parentPath, entry.name);
        const stat = await fs.lstat(full);
        entries.push([path.relative(directory, full), stat.mode, stat.size, stat.mtimeMs, stat.ino]);
    }
    return JSON.stringify(entries.sort());
}

// Registry records written by hand: reading them needs no /proc, unlike RobotStore.create.
async function handRobot(store, id, name) {
    await store.initialize();
    const root = store.robotPath(id);
    await fs.mkdir(path.join(root, 'home'), { recursive: true });
    const now = new Date().toISOString();
    const metadata = { schema: 'roboteam-robot-v1', id, name, codingAgents: ['opencode'], createdAt: now, updatedAt: now };
    await fs.writeFile(path.join(root, 'metadata.json'), JSON.stringify(metadata));
    return metadata;
}

async function profileFixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'robot-profile-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new RobotStore({ dataDir: path.join(root, '.data/roboTeamAgent') });
    const robot = await handRobot(store, 'analyst-a1b2c3', 'Analyst');
    return { root, store, robot, home: path.join(store.robotPath(robot.id), 'home') };
}

test('profile resolution answers from the robot registry and never changes anything', async t => {
    const { root, store, robot } = await profileFixture(t);
    const other = await handRobot(store, 'writer-d4e5f6', 'Writer');
    const before = await treeSnapshot(root);
    assert.deepEqual(await resolveTerminalProfile(store, robot.id, root), {
        allowed: true, profile: { id: robot.id, label: 'Analyst', home: `robots/${robot.id}/home` },
    });
    assert.equal(await robotTerminalHome(store, robot.id, root), `.data/roboTeamAgent/robots/${robot.id}/home`);
    for (const id of ['', 'x', 'unknown-robot-000', '../analyst', `${robot.id}/home`, 'ANALYST', null, 7, {}]) {
        assert.deepEqual(await resolveTerminalProfile(store, id, root), { allowed: false }, String(id));
    }
    assert.equal(await treeSnapshot(root), before);
    assert.deepEqual((await listTerminalProfiles(store)).map(profile => profile.label), ['Analyst', 'Writer']);
    assert.deepEqual((await listTerminalProfiles(store))[1], { id: other.id, label: 'Writer' });
});

test('profile resolution refuses a symlinked, replaced, missing or foreign home', async t => {
    const { root, store, robot, home } = await profileFixture(t);
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    const saved = path.join(root, 'saved-home');
    await fs.rename(home, saved);
    await fs.symlink(outside, home);
    assert.deepEqual(await resolveTerminalProfile(store, robot.id, root), { allowed: false }, 'symlinked home');
    await fs.rm(home);
    assert.deepEqual(await resolveTerminalProfile(store, robot.id, root), { allowed: false }, 'missing home');
    await fs.writeFile(home, 'not a directory');
    assert.deepEqual(await resolveTerminalProfile(store, robot.id, root), { allowed: false }, 'file as home');
    await fs.rm(home);
    await fs.rename(saved, home);
    assert.equal((await resolveTerminalProfile(store, robot.id, root)).allowed, true, 'restored home');
    // The workspace mount must project the very same robot, not a copy elsewhere.
    const elsewhere = new RobotStore({ dataDir: path.join(root, 'private') });
    const stray = await handRobot(elsewhere, 'stray-0a0b0c', 'Stray');
    assert.deepEqual(await resolveTerminalProfile(elsewhere, stray.id, root), { allowed: false }, 'outside the workspace data mount');
    // A symlinked robot root is refused through the existing root check.
    const symlinked = path.join(root, '.data/roboTeamAgent/robots', robot.id);
    await fs.rename(symlinked, path.join(root, 'moved-robot'));
    await fs.symlink(path.join(root, 'moved-robot'), symlinked);
    assert.deepEqual(await resolveTerminalProfile(store, robot.id, root), { allowed: false }, 'symlinked robot root');
});

test('terminal profile authority comes only from a verified signed administrator', () => {
    const admin = { ok: true, internal: false, canAdmin: true, principal: 'user:owner-1' };
    assert.equal(terminalProfileAccess(admin).ok, true);
    for (const access of [
        undefined, null, {}, { ok: false, status: 401, error: 'x' },
        { ...admin, canAdmin: false }, { ...admin, canAdmin: 'true' }, { ...admin, internal: true }, { ...admin, internal: undefined },
        { ...admin, principal: null }, { ...admin, principal: 'owner-1' }, { ...admin, principal: 'user:' }, { ...admin, principal: 'agent:x' },
        { ok: true, internal: true, canAdmin: false, principal: null },
    ]) {
        const decision = terminalProfileAccess(access);
        assert.equal(decision.ok, false, JSON.stringify(access));
        assert.equal(decision.status, 403);
    }
});

const ROBOT = 'analyst-a1b2c3';
function discovery(targets, profile = { provider: 'roboTeamAgent', id: ROBOT, label: 'Analyst' }) {
    return { ok: true, discovery: { id: 'd'.repeat(32), directory: 'robot/home', expiresAt: Date.now() + 60000, targets, ...(profile ? { profile } : {}) } };
}
const target = { kind: 'agent', detail: 'AchillesIDE/roboTeamAgent', access: 'rw', launch: 'x'.repeat(32) };

test('terminal asks the router for the robot profile with only a relative cwd and a fragment-only launch', async () => {
    const calls = [];
    const launch = await discoverRobotTerminal('robot/home', ROBOT, {
        cookie: 'ploinky_browser_csrf=proof',
        fetchImpl: async (...args) => { calls.push(args); return { ok: true, json: async () => discovery([target]) }; },
    });
    assert.equal(launch.url, '/webtty/#launch=' + target.launch);
    assert.equal(calls[0][0], '/webtty/target-discoveries');
    assert.deepEqual(JSON.parse(calls[0][1].body), { dir: 'robot/home', profile: { provider: 'roboTeamAgent', id: ROBOT } });
    assert.equal(calls[0][1].headers['x-ploinky-browser-csrf-token'], 'proof');
});

test('terminal cancels unusable discoveries rather than falling back to another agent or Box', async () => {
    const bad = [[], [{ ...target, kind: 'box' }], [target, target], [{ ...target, access: 'ro' }], [{ ...target, launch: 'https://wrong' }],
        [{ ...target, launch: undefined, unavailable: 'unknown-reason' }],
        // Two writable RoboTeam rows are ambiguous even when one is ineligible; the other is never picked.
        [target, { ...target, launch: undefined, unavailable: 'home-unreachable' }]];
    for (const targets of bad) {
        const calls = [];
        await assert.rejects(discoverRobotTerminal('robot/home', ROBOT, { cookie: '', fetchImpl: async (...args) => {
            calls.push(args); return { ok: true, json: async () => discovery(targets) };
        } }), /No unique/);
        assert.equal(calls[1][1].method, 'DELETE');
    }
});

test('terminal refuses a discovery the router did not bind to this robot', async () => {
    for (const profile of [null, { provider: 'roboTeamAgent', id: 'analyst-ffffff' }, { provider: 'otherAgent', id: ROBOT }, { id: ROBOT }]) {
        const calls = [];
        await assert.rejects(discoverRobotTerminal('robot/home', ROBOT, { cookie: '', fetchImpl: async (...args) => {
            calls.push(args); return { ok: true, json: async () => discovery([target], profile) };
        } }), /No unique/);
        assert.equal(calls[1][1].method, 'DELETE', 'the unusable launch is cancelled');
    }
});

test('terminal explains why the RoboTeam row cannot reach the robot home', async () => {
    const cases = [['home-unreachable', /cannot see the robot's home/], ['home-read-only', /only read the robot's home/]];
    for (const [unavailable, message] of cases) {
        const calls = [];
        await assert.rejects(discoverRobotTerminal('robot/home', ROBOT, { cookie: '', fetchImpl: async (...args) => {
            calls.push(args);
            return { ok: true, json: async () => discovery([{ ...target, launch: undefined, unavailable }, { kind: 'box', detail: 'Box', access: 'rw', launch: 'b'.repeat(32) }]) };
        } }), message);
        assert.equal(calls[1][1].method, 'DELETE');
    }
});

test('startup failures stay visible in the popup and cancel any unused launch', async () => {
    const popup = { opener: {}, document: { body: {} }, close: () => assert.fail('must keep error visible') };
    await assert.rejects(openRobotTerminal({ id: ROBOT }, async () => { throw new Error('home unavailable'); }, {
        windowRef: { open: () => popup },
    }), /home unavailable/);
    assert.equal(popup.document.title, 'Robot terminal could not open');
    assert.match(popup.document.body.textContent, /home unavailable/);
    let cancelled = false;
    popup.closed = true;
    await assert.rejects(openRobotTerminal({ id: ROBOT }, async () => ({ id: ROBOT, root: 'robot/home' }), {
        windowRef: { open: () => popup },
        discover: async () => ({ cancel: async () => { cancelled = true; } }),
    }), /window was closed/);
    assert.equal(cancelled, true);
});

test('the card prepares through the profile endpoint and discovers the prepared root for that robot', async () => {
    const requests = [];
    const discovered = [];
    const anchor = { click() { this.clicked = true; } };
    const popup = { opener: {}, document: { body: { appendChild() {} }, createElement: () => anchor } };
    await openRobotTerminal({ id: ROBOT, name: 'Analyst' }, async (...args) => {
        requests.push(args); return { ok: true, id: ROBOT, label: 'Analyst', root: `.data/roboTeamAgent/robots/${ROBOT}` };
    }, {
        windowRef: { open: () => popup },
        discover: async (...args) => { discovered.push(args); return { url: '/webtty/#launch=' + target.launch }; },
    });
    assert.deepEqual(requests, [[`api/terminal-profiles/${ROBOT}/prepare`, { method: 'POST', body: {} }]]);
    assert.deepEqual(discovered, [[`.data/roboTeamAgent/robots/${ROBOT}`, ROBOT]]);
    assert.equal(anchor.clicked, true);
    // A prepare answer for another robot or without a root never reaches discovery.
    for (const answer of [{ id: 'analyst-ffffff', root: 'robot/home' }, { id: ROBOT }, { id: ROBOT, root: '' }, {}, null]) {
        await assert.rejects(openRobotTerminal({ id: ROBOT, name: 'Analyst' }, async () => answer, {
            windowRef: { open: () => ({ opener: {}, document: { body: {} } }) },
            discover: async () => assert.fail('must not discover'),
        }), /unexpected terminal home/);
    }
});

test('blocked popups do not allocate a terminal; navigation strips opener and referrer', async () => {
    await assert.rejects(openRobotTerminal({ id: ROBOT }, () => assert.fail('must not request'), {
        windowRef: { open: () => null },
    }), /Allow popups/);
    const anchor = { click() { this.clicked = true; } };
    const popup = { opener: {}, document: { body: { appendChild() {} }, createElement: () => anchor } };
    await openRobotTerminal({ id: ROBOT, name: 'Analyst' }, async () => ({ id: ROBOT, root: 'robot/home' }), {
        windowRef: { open: () => popup }, discover: async () => ({ url: '/webtty/#launch=' + target.launch }),
    });
    assert.equal(popup.opener, null);
    assert.equal(anchor.referrerPolicy, 'no-referrer');
    assert.equal(anchor.rel, 'noopener noreferrer');
    assert.equal(anchor.clicked, true);
});

test('the manifest and the Explorer plugin declare the profile surfaces from the shared contract', async () => {
    const read = async file => JSON.parse(await fs.readFile(new URL(file, import.meta.url), 'utf8'));
    const base = '/base-agent-additional-server/roboTeamAgent/3001/api/terminal-profiles';
    const manifest = await read('../manifest.json');
    assert.deepEqual(manifest.webtty, { homeProfiles: { version: 1, resolve: `${base}/resolve` } });
    // The router admits the resolve call through the authenticated RoboTeam route.
    assert.ok(manifest.routerAccess.httpRoutes.some(route => route.access === 'authenticated' && route.path === '/base-agent-additional-server/roboTeamAgent/3001/*'));
    assert.deepEqual(await read('../IDE-plugins/terminal-profile-source/config.json'), {
        pluginCategory: 'application', id: 'roboteam-terminal-profiles', label: 'RoboTeam',
        contributionType: 'terminal-profile-source', location: ['terminal-profiles:source'],
        terminalProfiles: { version: 1, base },
    });
});
