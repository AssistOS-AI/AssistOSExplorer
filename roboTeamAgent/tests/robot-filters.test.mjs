import assert from 'node:assert/strict';
import test from 'node:test';
import { filterRobots, filtersActive, loginSummary, readRobotFilters, writeRobotFilters } from '../public/robot-filters.js';

const robots = [
    { id: 'ana-example-com-a1b2c3', name: 'ana@example.com', codingAgent: 'opencode', codingAgentLogins: { codex: false, opencode: true, pi: false, claude: true } },
    { id: 'bob-neirmail-com-d4e5f6', name: 'bob@neirmail.com', codingAgent: 'codex', codingAgentLogins: { codex: false, opencode: false, pi: false, claude: false } },
    { id: 'scout-0a0b0c', name: 'Scout', codingAgent: 'claude', codingAgentLogins: { codex: false, opencode: false, pi: false, claude: true } },
];
const names = list => list.map(robot => robot.name);
const filters = change => ({ query: '', login: '', agent: '', ...change });

test('search matches every word in the name or ID without case', () => {
    assert.deepEqual(names(filterRobots(robots, filters({ query: 'NEIRMAIL' }))), ['bob@neirmail.com']);
    assert.deepEqual(names(filterRobots(robots, filters({ query: 'example a1b2' }))), ['ana@example.com']);
    assert.deepEqual(names(filterRobots(robots, filters({}))), names(robots));
});

test('login and agent-in-use filters combine', () => {
    assert.deepEqual(names(filterRobots(robots, filters({ login: 'any' }))), ['ana@example.com', 'Scout']);
    assert.deepEqual(names(filterRobots(robots, filters({ login: 'none' }))), ['bob@neirmail.com']);
    assert.deepEqual(names(filterRobots(robots, filters({ login: 'claude', agent: 'opencode' }))), ['ana@example.com']);
    assert.deepEqual(names(filterRobots(robots, filters({ agent: 'pi' }))), []);
    const withoutLogins = robots.map(({ codingAgentLogins, ...robot }) => robot);
    assert.equal(filterRobots(withoutLogins, filters({ login: 'none' })).length, 3, 'without login data the login filter does not hide robots');
});

test('the card summary appears only for robots with a login', () => {
    assert.deepEqual(loginSummary(robots[0]), { text: 'Logged in 2/4', title: 'Logged in: OpenCode, Claude Code\nNot logged in: Codex, Pi' });
    assert.equal(loginSummary(robots[1]), null);
    assert.equal(loginSummary({ name: 'x' }), null);
});

test('filters survive in the dashboard URL beside other parameters', () => {
    const url = writeRobotFilters('https://ws.test/rt/?tab=cron-jobs', filters({ query: ' neirmail ', login: 'none', agent: 'opencode' }));
    assert.equal(url.search, '?tab=cron-jobs&q=neirmail&login=none&agent=opencode');
    assert.deepEqual(readRobotFilters(url.search), { query: 'neirmail', login: 'none', agent: 'opencode' });
    assert.deepEqual(readRobotFilters('?login=everyone&agent=gpt'), { query: '', login: '', agent: '' });
    assert.equal(writeRobotFilters(url, filters({})).search, '?tab=cron-jobs');
    assert.equal(filtersActive(filters({})), false);
    assert.equal(filtersActive(filters({ agent: 'pi' })), true);
});

test('every module the dashboard imports has a static route', async () => {
    const { readFile } = await import('node:fs/promises');
    const read = name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
    const server = await readFile(new URL('../server/http-server.mjs', import.meta.url), 'utf8');
    const seen = new Set();
    const pending = ['app.js'];
    while (pending.length) {
        const name = pending.pop();
        if (seen.has(name)) continue;
        seen.add(name);
        for (const [, imported] of (await read(name)).matchAll(/from '\.\/([\w-]+\.js)'/gu)) pending.push(imported);
    }
    for (const name of seen) assert.ok(server.includes(`'/${name}'`), `${name} is imported by the dashboard but not served`);
});

test('unknown logins (the worker reports none yet) neither filter robots out nor produce a summary', () => {
    const unknown = { id: 'u-aaaaaa', name: 'Unknown', codingAgent: 'codex', codingAgentLogins: { codex: 'unknown', opencode: 'unknown', pi: 'unknown', claude: 'unknown' } };
    for (const login of ['any', 'none', 'codex']) assert.deepEqual(names(filterRobots([unknown], filters({ login }))), ['Unknown'], login);
    assert.equal(loginSummary(unknown), null);
});
