import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { chatTurnUrl } from './robowork-interaction.mjs';
import { projectManifest } from './robowork-terminal.mjs';
import { scopedSkillTurn, assertAdmittedMarker, throwScenarioFailures, freshSkillConversation, assertNoProjectGrant, deleteOwnSkillRobotAfterChat } from './robowork-skills-fixture.mjs';

test('no-project chat input omits workspace-dir; every nonempty root or invalid input reaches Router validation intact', () => {
    for (const project of [undefined, null, '']) {
        const url = new URL(chatTurnUrl({ robot: 'test-robot', project, agent: 'roboTeamAgent' }), 'http://localhost');
        assert.equal(url.searchParams.has('workspace-dir'), false);
        assert.equal(url.searchParams.get('robot'), 'test-robot');
    }
    for (const project of ['project', '/', '.', './', '../other', 'missing-project', ' project ', '/tmp', '%2F', false, 0]) {
        const url = new URL(chatTurnUrl({ robot: 'test-robot', project }), 'http://localhost');
        assert.equal(url.searchParams.get('workspace-dir'), String(project));
    }
});

test('only exact root runtime directories may change; authored files, skill trees, nested and lookalike paths stay checked', () => {
    const root = fs.mkdtempSync(path.resolve('.ploinky/test-artifacts/h-authored-check-'));
    const write = (relative, content = 'authored') => {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), content);
    };
    try {
        const authored = ['README.md', '.agents/skills/marker/SKILL.md', '.claude/settings.json', 'nested/.agents/x', 'nested/.claude/x', 'nested/.roboteam/x', '.ROBOTEAM/x', '.roboteam-lookalike/x'];
        for (const name of authored) write(name);
        const before = projectManifest(root, { ignoreRootRuntime: true });
        write('.roboteam/sessions/conversation/session.json', 'runtime');
        write('.roboteam/history', 'runtime');
        assert.deepEqual(projectManifest(root, { ignoreRootRuntime: true }), before);
        assert.notDeepEqual(projectManifest(root), before, 'Other fixture users retain the full manifest by default');
        for (const name of authored) {
            write(name, 'changed');
            assert.notDeepEqual(projectManifest(root, { ignoreRootRuntime: true }), before, `${name} mutation cannot hide in runtime exclusions`);
            write(name);
        }
        fs.unlinkSync(path.join(root, 'README.md'));
        assert.notDeepEqual(projectManifest(root, { ignoreRootRuntime: true }), before, 'Authored deletion is detected');
        write('README.md');
        write('.agents/new-file');
        assert.notDeepEqual(projectManifest(root, { ignoreRootRuntime: true }), before, 'New authored skill paths are detected');
        fs.rmSync(path.join(root, '.roboteam'), { recursive: true });
        fs.symlinkSync('nested/.roboteam', path.join(root, '.roboteam'));
        assert.ok(projectManifest(root, { ignoreRootRuntime: true }).files.some((row) => row.path === '.roboteam' && row.link), 'A root alias is recorded, never followed or exempted');
        fs.unlinkSync(path.join(root, '.roboteam'));
        write('.roboteam', 'authored root file');
        assert.ok(projectManifest(root, { ignoreRootRuntime: true }).files.some((row) => row.path === '.roboteam' && row.sha256), 'An ordinary root file is recorded');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const sessionId = '12345678-1234-4234-8234-123456789abc';
const scope = { sinceMs: 1000, cwd: '/workspace/project', sessionId };
const turn = (overrides = {}) => ({ execution_id: 'turn', robot_id: 'worker-robot', kind: 'turn', created_at: 1100,
    specification: { cwd: scope.cwd, sessionId }, state: 'completed', end_classification: 'completed', ...overrides });
const ledger = (executions) => ({ robot: { id: 'worker-robot' }, executions });

test('fresh conversation selection uses a new UUID and the exact robot, including root metadata sessions', () => {
    const origin = 'http://localhost:8080';
    const robotId = 'e2e-h-123456abcdef';
    const link = (id, robot = robotId) => `/base-agent-additional-server/roboTeamAgent/3001/conversation-skills/${robot}/${id}`;
    const previousLink = link(sessionId);
    const freshId = '87654321-4321-4321-8321-cba987654321';
    const selectedLink = link(freshId);
    assert.equal(freshSkillConversation({ previousLink: null, selectedLink, origin, robotId }).sessionId, freshId);
    assert.equal(freshSkillConversation({ previousLink, selectedLink, origin, robotId }).previousSessionId, sessionId);
    assert.throws(() => freshSkillConversation({ previousLink, selectedLink: previousLink, origin, robotId }));
    assert.throws(() => freshSkillConversation({ previousLink, selectedLink: link(freshId, 'another-robot'), origin, robotId }));
    assert.throws(() => freshSkillConversation({ previousLink, selectedLink: null, origin, robotId }));
});

test('root metadata context never permits a worker project cwd, folder grant or ignore path', () => {
    assertNoProjectGrant(turn({ specification: {} }));
    assertNoProjectGrant(turn({ specification: { cwd: '', folders: [], ignore: [] } }));
    for (const specification of [{ cwd: '/workspace' }, { folders: [{ path: '/workspace', access: 'write' }] }, { ignore: ['/workspace/.roboteam'] }]) {
        assert.throws(() => assertNoProjectGrant(turn({ specification })));
    }
});

function chatCleanupRig(replies) {
    let time = 0; let calls = 0; let detached = false; let confirmed = false;
    const robot = { id: 'own-chat-robot', name: 'e2e-h-123456abcdef' };
    const state = { robot: { id: 'worker-robot', name: robot.name, lifecycle: 'ready' }, executions: [turn({ blockers: [{ release_state: 'released', retained: 0 }] })] };
    const events = [];
    const options = {
        robot, ownedNamePrefix: robot.name,
        now: () => time, sleep: async (ms) => { assert.ok(ms <= 1000); time += ms; },
        detachOwnChat: async () => { detached = true; events.push('detach own chat'); },
        readLedger: () => structuredClone(state),
        removeRobot: async (id) => {
            assert.equal(id, robot.id);
            assert.equal(detached, true);
            assert.ok(time >= 121_000, 'No delete before the documented disconnect grace and disposal margin');
            events.push('delete');
            const reply = replies[Math.min(calls++, replies.length - 1)];
            if (reply.status === 200) state.robot.lifecycle = 'deleted';
            return reply;
        },
        confirmAbsent: async () => { confirmed = true; events.push('confirmed absent'); },
    };
    return { options, state, events, calls: () => calls, confirmed: () => confirmed };
}

test('owned chat cleanup detaches before grace, and only the exact CLI usage refusal may retry', async (t) => {
    const cliBusy = { status: 409, payload: { error: 'close the robot chat and stop its CLI tasks before deleting it' } };
    const r = chatCleanupRig([cliBusy, { status: 200 }]);
    await deleteOwnSkillRobotAfterChat(r.options);
    assert.deepEqual(r.events, ['detach own chat', 'delete', 'delete', 'confirmed absent']);
    for (const reply of [{ status: 409, payload: { error: 'stop the robot and its queued tasks before deleting it' } },
        { status: 409, payload: { error: 'the robot has running or unsettled work; stop it first' } },
        { status: 409, payload: { error: 'unknown refusal' } }, { status: 403 }, { status: 500 }]) {
        await t.test(`${reply.status}/${reply.payload?.error || ''}`, async () => {
            const refused = chatCleanupRig([reply]);
            await assert.rejects(deleteOwnSkillRobotAfterChat(refused.options));
            assert.equal(refused.calls(), 1);
            assert.equal(refused.confirmed(), false);
        });
    }
    const stuck = chatCleanupRig([cliBusy]);
    await assert.rejects(deleteOwnSkillRobotAfterChat(stuck.options), /close the robot chat/);
    assert.equal(stuck.calls(), 3);
    assert.equal(stuck.confirmed(), false);
});

test('chat cleanup cannot detach/delete another robot or delete active AI work', async () => {
    const other = chatCleanupRig([{ status: 200 }]);
    other.options.robot = { ...other.options.robot, name: 'another-robot' };
    await assert.rejects(deleteOwnSkillRobotAfterChat(other.options), /exactly the robot/);
    assert.deepEqual(other.events, []);
    const active = chatCleanupRig([{ status: 200 }]);
    active.state.executions[0].state = 'running';
    await assert.rejects(deleteOwnSkillRobotAfterChat(active.options), /Active or unsettled turn/);
    assert.equal(active.calls(), 0);
    const detached = chatCleanupRig([{ status: 200 }]);
    detached.options.detachOwnChat = async () => { throw new Error('own navigation failed'); };
    await assert.rejects(deleteOwnSkillRobotAfterChat(detached.options), /own navigation failed/);
    assert.equal(detached.calls(), 0);
});

test('only documented utility admissions are excluded; exactly one scoped completed AI turn is required', () => {
    assert.equal(scopedSkillTurn(ledger([turn({ execution_id: 'old', created_at: 999 }), turn({ kind: 'utility' }), turn()]), scope).execution_id, 'turn');
    for (const execution of [turn({ kind: 'terminal' }), turn({ kind: 'unknown' }), turn({ robot_id: 'other' }),
        turn({ state: 'failed' }), turn({ end_classification: 'failed' }), turn({ specification: { cwd: '/other', sessionId } }),
        turn({ specification: { cwd: scope.cwd, sessionId: 'another-session' } })]) {
        assert.throws(() => scopedSkillTurn(ledger([execution]), scope));
    }
    for (const kind of ['terminal', 'unknown', 'turn']) assert.throws(() => scopedSkillTurn(ledger([turn(), turn({ kind })]), scope));
    assert.throws(() => scopedSkillTurn(ledger([turn({ kind: 'utility' })]), scope));
    assert.throws(() => scopedSkillTurn(ledger([turn()]), { ...scope, sessionId: undefined }));
    assert.throws(() => scopedSkillTurn(ledger([turn()]), { ...scope, sinceMs: undefined }));
});

test('cleanup errors preserve the original timeout as the primary cause', () => {
    const primary = new Error('The model turn timed out');
    const mutation = new Error('Authored file changed');
    assert.throws(() => throwScenarioFailures(primary, []), (error) => error === primary);
    assert.throws(() => throwScenarioFailures(primary, [mutation]), (error) => error instanceof AggregateError
        && error.cause === primary && error.errors[0] === primary && error.errors[1] === mutation && error.message.includes(primary.message));
    assert.throws(() => throwScenarioFailures(null, [mutation]), (error) => error instanceof AggregateError && error.errors[0] === mutation);
    throwScenarioFailures(null, []);
});

test('UI selection alone cannot substitute for the exact admitted marker source', () => {
    const marker = { name: 'nonce-marker', path: '/workspace/markerrepo/nonce-marker' };
    assertAdmittedMarker(turn({ specification: { skills: [{ name: 'human-report', path: '/workspace/bundled/human-report' }, marker] } }), marker);
    for (const skills of [undefined, [], [{ name: 'human-report', path: '/workspace/bundled/human-report' }],
        [{ ...marker, path: '/workspace/another/nonce-marker' }], [marker, marker]]) {
        assert.throws(() => assertAdmittedMarker(turn({ specification: { skills } }), marker));
    }
});

// Exercise the actual orchestration body with deterministic I/O; no browser/server/model is started.
test('chatTurn awaits beforeSend before composer/send, and a failed selection hook never sends a prompt', async () => {
    const source = fs.readFileSync(new URL('./robowork-interaction.mjs', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('export async function chatTurn('), source.indexOf('// Stops a WebChat generation')).replace('export async function', 'async function');
    const order = [];
    const chat = new Function('expect', 'chatTurnUrl', 'setComposer', 'BOT', `${body}; return chatTurn;`)(
        () => ({ toBeVisible: async () => order.push('visible') }), chatTurnUrl,
        async () => order.push('composer'), 'BOT',
    );
    const page = {
        goto: async () => order.push('goto'), waitForTimeout: async () => {},
        locator(selector) {
            return { count: async () => 0, allTextContents: async () => ['answer'], isVisible: async () => false,
                click: async () => order.push(selector === '#send' ? 'send' : selector) };
        },
    };
    const answer = await chat(page, { robot: 'bot', project: '', prompt: 'test', beforeSend: async () => { await Promise.resolve(); order.push('selected'); } });
    assert.equal(answer, 'answer');
    assert.deepEqual(order, ['goto', 'visible', 'selected', 'composer', 'send']);
    order.length = 0;
    const failure = new Error('Conversation selection failed');
    await assert.rejects(chat(page, { robot: 'bot', prompt: 'test', beforeSend: async () => { throw failure; } }), (error) => error === failure);
    assert.deepEqual(order, ['goto', 'visible']);
});
