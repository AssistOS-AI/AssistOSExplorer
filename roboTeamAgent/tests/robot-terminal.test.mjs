import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverRobotTerminal, openRobotTerminal, prepareRobotTerminal } from '../public/terminal.js';

const ROBOT = 'analyst-a1b2c3';
const PROFILE = `${ROBOT}.default`;
const ROOT = `.data/roboWorkAgent/terminal/${ROBOT}`;
const target = { kind: 'agent', detail: 'AchillesIDE/roboWorkAgent', access: 'rw', launch: 'x'.repeat(32) };
function discovery(targets, profile = { provider: 'roboWorkAgent', id: PROFILE, label: 'Analyst' }) {
    return { ok: true, discovery: { id: 'd'.repeat(32), directory: ROOT, expiresAt: Date.now() + 60000, targets, ...(profile ? { profile } : {}) } };
}
const prepared = () => ({ ok: true, id: PROFILE, label: 'Analyst', root: ROOT });

test('terminal discovery names RoboWork and compound profile, with relative cwd and fragment-only launch', async () => {
    const calls = [];
    const launch = await discoverRobotTerminal(ROOT, PROFILE, {
        cookie: 'ploinky_browser_csrf=proof',
        fetchImpl: async (...args) => { calls.push(args); return { ok: true, json: async () => discovery([target]) }; },
    });
    assert.equal(launch.url, '/webtty/#launch=' + target.launch);
    assert.equal(calls[0][0], '/webtty/target-discoveries');
    assert.deepEqual(JSON.parse(calls[0][1].body), { dir: ROOT, profile: { provider: 'roboWorkAgent', id: PROFILE } });
    assert.equal(calls[0][1].headers['x-ploinky-browser-csrf-token'], 'proof');
    assert.equal(calls[0][1].credentials, 'same-origin');
    assert.doesNotMatch(calls[0][1].body, /\/home\/|\/data\//u);
});

test('terminal cancels missing, read-only, ambiguous and wrong-provider rows without falling back to Box or RoboTeam', async () => {
    const bad = [[], [{ ...target, kind: 'box' }], [{ ...target, detail: 'AchillesIDE/roboTeamAgent' }],
        [target, target], [{ ...target, access: 'ro' }], [{ ...target, launch: 'https://wrong' }],
        [{ ...target, launch: undefined, unavailable: 'unknown-reason' }],
        [target, { ...target, launch: undefined, unavailable: 'home-unreachable' }]];
    for (const targets of bad) {
        const calls = [];
        await assert.rejects(discoverRobotTerminal(ROOT, PROFILE, { cookie: '', fetchImpl: async (...args) => {
            calls.push(args); return { ok: true, json: async () => discovery(targets) };
        } }), /No unique/);
        assert.equal(calls[1][1].method, 'DELETE');
    }
});

test('terminal refuses a discovery not bound to the exact robot and environment', async () => {
    for (const profile of [null, { provider: 'roboWorkAgent', id: ROBOT },
        { provider: 'roboWorkAgent', id: `${ROBOT}.other` }, { provider: 'roboTeamAgent', id: PROFILE }, { id: PROFILE }]) {
        const calls = [];
        await assert.rejects(discoverRobotTerminal(ROOT, PROFILE, { cookie: '', fetchImpl: async (...args) => {
            calls.push(args); return { ok: true, json: async () => discovery([target], profile) };
        } }), /No unique/);
        assert.equal(calls[1][1].method, 'DELETE');
    }
});

test('terminal explains why the RoboWork row cannot reach the robot home', async () => {
    for (const [unavailable, message] of [['home-unreachable', /cannot see the robot's home/], ['home-read-only', /only read the robot's home/]]) {
        const calls = [];
        await assert.rejects(discoverRobotTerminal(ROOT, PROFILE, { cookie: '', fetchImpl: async (...args) => {
            calls.push(args);
            return { ok: true, json: async () => discovery([{ ...target, launch: undefined, unavailable },
                { kind: 'box', detail: 'Box', access: 'rw', launch: 'b'.repeat(32) }]) };
        } }), message);
        assert.equal(calls[1][1].method, 'DELETE');
    }
});

test('prepare uses the absolute RoboWork route, browser CSRF proof and empty JSON body', async () => {
    const requests = [];
    const answer = await prepareRobotTerminal(PROFILE, { cookie: 'ploinky_browser_csrf=proof',
        fetchImpl: async (...args) => { requests.push(args); return { ok: true, json: async () => prepared() }; } });
    assert.deepEqual(answer, prepared());
    assert.equal(requests[0][0], `/base-agent-additional-server/roboWorkAgent/3001/api/terminal-profiles/${PROFILE}/prepare`);
    assert.equal(requests[0][1].headers['x-ploinky-browser-csrf-token'], 'proof');
    assert.equal(requests[0][1].credentials, 'same-origin');
    assert.equal(requests[0][1].body, '{}');
    await assert.rejects(prepareRobotTerminal(PROFILE, { cookie: '', fetchImpl: async () => ({ ok: false, json: async () => ({ ok: false }) }) }), /Administrator/);
});

test('startup failures stay visible in the popup and cancel any unused launch', async () => {
    const popup = { opener: {}, document: { body: {} }, close: () => assert.fail('must keep error visible') };
    await assert.rejects(openRobotTerminal({ id: ROBOT }, () => assert.fail('relative RT api must not run'), {
        windowRef: { open: () => popup }, prepare: async () => { throw new Error('home unavailable'); },
    }), /home unavailable/);
    assert.equal(popup.document.title, 'Robot terminal could not open');
    assert.match(popup.document.body.textContent, /home unavailable/);
    let cancelled = false;
    popup.closed = true;
    await assert.rejects(openRobotTerminal({ id: ROBOT }, null, {
        windowRef: { open: () => popup }, prepare: async () => prepared(),
        discover: async () => ({ cancel: async () => { cancelled = true; } }),
    }), /window was closed/);
    assert.equal(cancelled, true);
});

test('card prepares and discovers the default RoboWork profile; wrong replies never reach discovery', async () => {
    const requests = [], discovered = [];
    const anchor = { click() { this.clicked = true; } };
    const popup = { opener: {}, document: { body: { appendChild() {} }, createElement: () => anchor } };
    await openRobotTerminal({ id: ROBOT, name: 'Analyst' }, () => assert.fail('relative RT api must not run'), {
        windowRef: { open: () => popup }, prepare: async id => { requests.push(id); return prepared(); },
        discover: async (...args) => { discovered.push(args); return { url: '/webtty/#launch=' + target.launch }; },
    });
    assert.deepEqual(requests, [PROFILE]);
    assert.deepEqual(discovered, [[ROOT, PROFILE]]);
    assert.equal(anchor.clicked, true);
    for (const answer of [{ id: ROBOT, root: ROOT }, { id: PROFILE }, { id: PROFILE, root: '' }, {}, null]) {
        await assert.rejects(openRobotTerminal({ id: ROBOT, name: 'Analyst' }, null, {
            windowRef: { open: () => ({ opener: {}, document: { body: {} } }) }, prepare: async () => answer,
            discover: async () => assert.fail('must not discover'),
        }), /unexpected terminal home/);
    }
});

test('blocked popups do not allocate a terminal; navigation strips opener and referrer', async () => {
    await assert.rejects(openRobotTerminal({ id: ROBOT }, null, {
        windowRef: { open: () => null }, prepare: () => assert.fail('must not request'),
    }), /Allow popups/);
    const anchor = { click() { this.clicked = true; } };
    const popup = { opener: {}, document: { body: { appendChild() {} }, createElement: () => anchor } };
    await openRobotTerminal({ id: ROBOT, name: 'Analyst' }, null, {
        windowRef: { open: () => popup }, prepare: async () => prepared(), discover: async () => ({ url: '/webtty/#launch=' + target.launch }),
    });
    assert.equal(popup.opener, null);
    assert.equal(anchor.referrerPolicy, 'no-referrer');
    assert.equal(anchor.rel, 'noopener noreferrer');
    assert.equal(anchor.clicked, true);
});
