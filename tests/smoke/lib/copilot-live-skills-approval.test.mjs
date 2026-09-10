import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { approveLiveSkillsRequest, validateLiveSkillsApproval } from './copilot-live-skills-approval.mjs';
import { createLiveSkillsFixture, liveSkillSources, liveSkillsPrompt } from './copilot-live-skills.mjs';

function fixtureCase() {
    const fixture = createLiveSkillsFixture(), sessionId = randomUUID(), phase = randomUUID(), turnId = randomUUID();
    const selected = [fixture.control, fixture.probe];
    const threadId = randomUUID(), nativeTurnId = randomUUID(), interactionId = `task_control_${randomUUID().replaceAll('-', '_')}`;
    const revision = 'a'.repeat(64), baseURL = 'http://localhost:8080';
    const command = `node /workspace/.agents/skills/${fixture.control.name}/receipt.mjs ${phase}`;
    const detail = { threadId, turnId: nativeTurnId, itemId: 'native-item', cwd: '/workspace', command,
        item: { id: 'native-item', type: 'commandExecution', cwd: '/workspace', command } };
    const entries = selected.map(skill => ({ name: skill.name, identity: `workspace:${fixture.folder}/.agents/skills/${skill.name}` }));
    return { fixture, sessionId, phase, selected, baselineIds: [], decisions: [], baseURL,
        browserURL: `${baseURL}/webchat?agent=roboTeamAgent&robot=default&workspace-dir=${fixture.folder}`,
        settingsURL: `${baseURL}/explorer/index.html?copilot-robot=default&copilot-session=${sessionId}`,
        ui: { title: 'Codex permission request', detail: JSON.stringify(detail), options: [
            { id: `interaction-option-${interactionId}-0`, label: 'Deny', description: 'Decline this operation and continue the turn.' },
            { id: `interaction-option-${interactionId}-1`, label: 'Allow once', description: 'Approve this operation.' },
        ] },
        snapshot: { native: { id: sessionId, workspace: fixture.workspace, agent: 'codex', continuation: { threadId } },
            session: { sessionId, cwd: fixture.workspace, skillExecution: { active: true, revision, resolvedSkills: entries.map(entry => entry.identity) },
                messages: [{ role: 'user', id: randomUUID(), turnId, text: liveSkillsPrompt({ phase, selected }) },
                    { role: 'assistant', id: randomUUID(), turnId, status: 'pending' }] },
            catalog: { revision, entries }, capturedFiles: Object.fromEntries(selected.map(skill => {
                const source = liveSkillSources(fixture, skill);
                return [skill.name, { descriptorSha256: source.descriptorSha256, helperSha256: source.helperSha256 }];
            })) } };
}

function changeDetail(input, mutate) {
    const detail = JSON.parse(input.ui.detail);
    mutate(detail);
    input.ui.detail = JSON.stringify(detail);
}
function command(input, value) { changeDetail(input, detail => { detail.command = detail.item.command = value; }); }

test('one-time helper approval binds current browser, captured sources, native conversation and challenge', () => {
    const input = fixtureCase();
    const decision = validateLiveSkillsApproval(input);
    assert.equal(decision.optionId, 'choice_1');
    assert.equal(decision.decision, 'accept');
    assert.equal(decision.helper, input.fixture.control.name);
    assert.notEqual(decision.nativeTurnId, decision.turnId);
});

test('literal reads may cover only the selected current descriptor and helper files', () => {
    const input = fixtureCase();
    command(input, `cat /workspace/.agents/skills/${input.fixture.control.name}/SKILL.md /workspace/.agents/skills/${input.fixture.probe.name}/receipt.mjs`);
    assert.equal(validateLiveSkillsApproval(input).helper, null);
});

const corruptions = {
    'different browser conversation': input => { input.settingsURL = input.settingsURL.replace(input.sessionId, randomUUID()); },
    'different browser workspace': input => { input.browserURL = input.browserURL.replace(input.fixture.folder, 'foreign'); },
    'different browser origin': input => { input.browserURL = input.browserURL.replace('localhost', 'foreign.test'); },
    'different native thread': input => changeDetail(input, detail => { detail.threadId = randomUUID(); }),
    'changed continuing conversation': input => { input.nativeIdentity = { sessionId: input.sessionId,
        home: input.snapshot.native.home, workspace: input.fixture.workspace, agent: 'codex', threadId: randomUUID() }; },
    'different native workspace': input => { input.snapshot.native.workspace = '/workspace/foreign'; },
    'stale or inactive turn': input => { input.snapshot.session.skillExecution.active = false; },
    'completed assistant': input => { input.snapshot.session.messages[1].status = 'completed'; },
    'previous assistant': input => { input.baselineIds.push(input.snapshot.session.messages[1].id); },
    'different current phase': input => { input.phase = randomUUID(); },
    'different user prompt': input => { input.snapshot.session.messages[0].text += ' another task'; },
    'different native cwd': input => changeDetail(input, detail => { detail.cwd = '/foreign'; }),
    'different item cwd': input => changeDetail(input, detail => { detail.item.cwd = '/foreign'; }),
    'missing native item': input => changeDetail(input, detail => { delete detail.item; }),
    'missing native item id': input => changeDetail(input, detail => { delete detail.itemId; delete detail.item.id; }),
    'different item command': input => changeDetail(input, detail => { detail.item.command = 'rm -rf /workspace'; }),
    'file changes': input => changeDetail(input, detail => { detail.item.type = 'fileChange'; }),
    'permission profile grant': input => changeDetail(input, detail => { detail.permissions = { filesystem: 'all' }; }),
    'foreign helper': input => command(input, `node /workspace/foreign/receipt.mjs ${input.phase}`),
    'disabled or unselected helper': input => command(input, `node /workspace/.agents/skills/${input.fixture.added.name}/receipt.mjs ${input.phase}`),
    'helper phase mismatch': input => command(input, `node /workspace/.agents/skills/${input.fixture.control.name}/receipt.mjs ${randomUUID()}`),
    'extra argument': input => command(input, `node /workspace/.agents/skills/${input.fixture.control.name}/receipt.mjs ${input.phase} extra`),
    'extra operator': input => command(input, `cat /workspace/.agents/skills/${input.fixture.control.name}/SKILL.md; pwd`),
    'substitution': input => command(input, `cat $(pwd)/.agents/skills/${input.fixture.control.name}/SKILL.md`),
    'shell wrapper': input => command(input, `/bin/bash -lc 'cat /workspace/.agents/skills/${input.fixture.control.name}/SKILL.md'`),
    'foreign read': input => command(input, 'cat /workspace/.env'),
    'traversal': input => command(input, `cat /workspace/.agents/skills/${input.fixture.control.name}/../../../.env`),
    'persistent grant only': input => { input.ui.options[1].label = 'Allow for native session'; },
    'ambiguous approval choice': input => { input.ui.options.push({ ...input.ui.options[1], id: input.ui.options[1].id.replace(/1$/, '2') }); },
    'different interaction id': input => { input.ui.options[0].id = `interaction-option-task_control_${randomUUID().replaceAll('-', '_')}-0`; },
    'catalog revision mismatch': input => { input.snapshot.catalog.revision = 'b'.repeat(64); },
    'changed current helper': input => { input.snapshot.capturedFiles[input.fixture.control.name].helperSha256 = 'b'.repeat(64); },
    'excluded skill': input => { input.snapshot.session.skillExecution.resolvedSkills.pop(); },
    'truncated detail': input => { input.ui.detail = input.ui.detail.slice(0, -1); },
};
for (const [name, corrupt] of Object.entries(corruptions)) test(`approval rejects ${name}`, () => {
    const input = fixtureCase(); corrupt(input);
    assert.throws(() => validateLiveSkillsApproval(input));
});

test('a previously approved interaction or helper is never approved a second time', () => {
    const input = fixtureCase(), decision = validateLiveSkillsApproval(input);
    input.decisions.push(decision);
    assert.throws(() => validateLiveSkillsApproval(input), /already approved/);
    command(input, `cat /workspace/.agents/skills/${input.fixture.control.name}/SKILL.md`);
    assert.throws(() => validateLiveSkillsApproval(input), /replayed/);
});

function browserFixture(input) {
    const actions = [], evidence = { approvals: [] };
    let predicate, resolveResponse;
    const prompt = { isVisible: async () => true, evaluate: async () => structuredClone(input.ui) };
    const page = { url: () => input.browserURL,
        locator(selector) {
            if (selector === '#interactionPrompt') return prompt;
            if (selector === '#sessionSettingsLink') return { getAttribute: async () => input.settingsURL };
            return { click: async () => {
                actions.push(selector);
                const id = selector.match(/interaction-option-(.*)-1$/)[1];
                const response = { url: () => input.browserURL.replace('/webchat?', '/webchat/interaction?'), status: () => 204,
                    request: () => ({ method: () => 'POST', postDataJSON: () => ({ interactionId: id, optionId: 'choice_1' }) }) };
                assert.equal(predicate(response), true);
                resolveResponse(response);
            }, waitFor: async options => { assert.equal(options.state, 'detached'); actions.push('resolved'); } };
        },
        waitForResponse(match) { predicate = match; return new Promise(resolve => { resolveResponse = resolve; }); },
    };
    return { page, evidence, actions, prompt };
}

test('normal UI click sends the exact one-time choice and records its accepted resolution', async () => {
    const input = fixtureCase(), browser = browserFixture(input);
    await approveLiveSkillsRequest({ ...input, ...browser, remaining: () => 1000 });
    assert.equal(browser.actions.length, 2);
    assert.equal(browser.actions[1], 'resolved');
    assert.equal(browser.evidence.approvals[0].decision, 'accept');
    assert.equal(browser.evidence.pendingApproval, undefined);
});

test('an unexpected visible command preserves the request and fails before any click', async () => {
    const input = fixtureCase(), browser = browserFixture(input);
    command(input, 'rm -rf /workspace');
    await assert.rejects(approveLiveSkillsRequest({ ...input, ...browser, remaining: () => 1000 }));
    assert.equal(browser.actions.length, 0);
    assert.ok(browser.evidence.pendingApproval);
    assert.equal(browser.evidence.approvals.length, 0);
});

test('no interaction causes no approval operation', async () => {
    const input = fixtureCase(), browser = browserFixture(input);
    browser.prompt.isVisible = async () => false;
    await approveLiveSkillsRequest({ ...input, ...browser, remaining: () => 1000 });
    assert.equal(browser.actions.length, 0);
    assert.equal(browser.evidence.approvals.length, 0);
});
