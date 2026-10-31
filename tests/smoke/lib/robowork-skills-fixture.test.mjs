import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { chatTurnUrl } from './robowork-interaction.mjs';
import { projectManifest } from './robowork-terminal.mjs';
import { scopedSkillTurn, assertAdmittedMarker, throwScenarioFailures } from './robowork-skills-fixture.mjs';

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
