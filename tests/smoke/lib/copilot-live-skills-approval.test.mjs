import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { approveLiveSkillsRequest, validateLiveSkillsApproval, parseLiveSkillsApprovalCommand } from './copilot-live-skills-approval.mjs';
import { currentLiveSkillsCase } from './copilot-live-skills-test-fixture.mjs';
import { createLiveSkillsFixture, liveSkillSources, liveSkillsPrompt } from './copilot-live-skills.mjs';

// Approval commands run in the ALA-native /workspace namespace; the observer evidence uses the admitted outer root.
const workspaceRoot = '/srv/fresh-workspace';

function fixtureCase() {
    const current = currentLiveSkillsCase({ root: workspaceRoot });
    const { fixture, snapshot, selected, sessionId, phase } = current;
    const nativeTurnId = randomUUID(), interactionId = `task_control_${randomUUID().replaceAll('-', '_')}`;
    const threadId = snapshot.native.continuation.threadId, baseURL = 'http://localhost:8080';
    const command = `node ${fixture.workspace}/.agents/skills/${fixture.control.name}/receipt.mjs ${phase}`;
    const detail = { threadId, turnId: nativeTurnId, itemId: 'native-item', cwd: fixture.workspace, command,
        item: { id: 'native-item', type: 'commandExecution', cwd: fixture.workspace, command } };
    snapshot.receipts = {};
    snapshot.session.skillExecution.active = true;
    snapshot.session.messages[1].status = 'pending';
    return { ...current, decisions: [], baseURL,
        browserURL: `${baseURL}/webchat?agent=roboTeamAgent&robot=${fixture.robotName}&workspace-dir=${fixture.folder}`,
        settingsURL: `${baseURL}/base-agent-additional-server/roboTeamAgent/3001/conversation-skills/${fixture.robotId}/${sessionId}`,
        ui: { title: 'Codex permission request', detail: JSON.stringify(detail), options: [
            { id: `interaction-option-${interactionId}-0`, label: 'Deny', description: 'Decline this operation and continue the turn.' },
            { id: `interaction-option-${interactionId}-1`, label: 'Allow once', description: 'Approve this operation.' },
        ] } };
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
    command(input, `cat ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/SKILL.md ${input.fixture.workspace}/.agents/skills/${input.fixture.probe.name}/receipt.mjs`);
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
    'disabled or unselected helper': input => command(input, `node ${input.fixture.workspace}/.agents/skills/${input.fixture.added.name}/receipt.mjs ${input.phase}`),
    'helper phase mismatch': input => command(input, `node ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/receipt.mjs ${randomUUID()}`),
    'extra argument': input => command(input, `node ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/receipt.mjs ${input.phase} extra`),
    'extra operator': input => command(input, `cat ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/SKILL.md; pwd`),
    'substitution': input => command(input, `cat $(pwd)/.agents/skills/${input.fixture.control.name}/SKILL.md`),
    'arbitrary shell wrapper': input => command(input, `/bin/sh -c 'cat ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/SKILL.md'`),
    'foreign read': input => command(input, 'cat /workspace/.env'),
    'traversal': input => command(input, `cat ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/../../../.env`),
    'persistent grant only': input => { input.ui.options[1].label = 'Allow for native session'; },
    'ambiguous approval choice': input => { input.ui.options.push({ ...input.ui.options[1], id: input.ui.options[1].id.replace(/1$/, '2') }); },
    'different interaction id': input => { input.ui.options[0].id = `interaction-option-task_control_${randomUUID().replaceAll('-', '_')}-0`; },
    'catalog revision mismatch': input => { input.snapshot.catalog.revision = 'b'.repeat(64); },
    'changed current helper': input => { input.snapshot.capturedFiles[input.fixture.control.name].helperSha256 = 'b'.repeat(64); },
    'excluded skill': input => { input.snapshot.session.skillExecution.entries.pop(); },
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
    command(input, `cat ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/SKILL.md`);
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

test('the observed native bash wrapper and unknown commandActions require validation of both real operations', () => {
    const input = fixtureCase();
    const inner = `ls -la ${input.fixture.workspace}/.agents/skills && cat ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/SKILL.md ${input.fixture.workspace}/.agents/skills/${input.fixture.probe.name}/SKILL.md`;
    command(input, `/bin/bash -lc '${inner}'`);
    changeDetail(input, detail => {
        detail.commandActions = detail.item.commandActions = [{ type: 'unknown', command: inner }];
        detail.availableDecisions = ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['ls', '-la', `${input.fixture.workspace}/.agents/skills`] } }, 'cancel'];
    });
    const idPrefix = input.ui.options[0].id.slice(0, -1);
    input.ui.options = [
        { id: `${idPrefix}0`, label: 'Allow once', description: 'Approve this operation.' },
        { id: `${idPrefix}1`, label: 'Allow with execution policy amendment', description: JSON.stringify(['ls', '-la', `${input.fixture.workspace}/.agents/skills`]) },
        { id: `${idPrefix}2`, label: 'Cancel turn', description: 'Decline this operation and interrupt the turn.' },
    ];
    const decision = validateLiveSkillsApproval(input);
    assert.equal(decision.shell, '/bin/bash -lc');
    assert.deepEqual(decision.operations, [['ls', '-la', `${input.fixture.workspace}/.agents/skills`],
        ['cat', `${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/SKILL.md`, `${input.fixture.workspace}/.agents/skills/${input.fixture.probe.name}/SKILL.md`]]);
    assert.deepEqual(decision.helpers, []);
    assert.equal(decision.decision, 'accept');
    assert.equal(decision.optionId, 'choice_0');
});

test('quoted literal paths and a chain of distinct current helpers keep every helper in the decision receipt', () => {
    const input = fixtureCase();
    const helpers = input.selected.map(skill => `node '${input.fixture.workspace}/.agents/skills/${skill.name}/receipt.mjs' '${input.phase}'`);
    command(input, `/bin/bash -lc "${helpers.join(' && ')}"`);
    const decision = validateLiveSkillsApproval(input);
    assert.deepEqual(decision.helpers, input.selected.map(skill => skill.name));
    assert.equal(decision.operations.length, 2);
    input.decisions.push(decision);
    command(input, `node ${input.fixture.workspace}/.agents/skills/${input.fixture.probe.name}/receipt.mjs ${input.phase}`);
    assert.throws(() => validateLiveSkillsApproval(input), /already approved/);
});

test('POSIX quote concatenation decodes to literal inner path quotes without evaluating shell text', () => {
    const input = fixtureCase();
    const path = `${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/SKILL.md`;
    const inner = `cat '${path}'`;
    const quoted = "'" + inner.replaceAll("'", "'\"'\"'") + "'";
    command(input, `/bin/bash -lc ${quoted}`);
    assert.deepEqual(validateLiveSkillsApproval(input).operations, [['cat', path]]);
});

test('listing is restricted to the mounted catalog root or a selected skill directory', () => {
    const input = fixtureCase();
    for (const flags of ['', '-l ', '-a ', '-la ', '-al ', '-l -a ']) {
        for (const path of [`${input.fixture.workspace}/.agents/skills`, `${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}`]) {
            command(input, `ls ${flags}'${path}'`);
            assert.equal(validateLiveSkillsApproval(input).operations[0].at(-1), path);
        }
    }
});

const chainCorruptions = {
    'foreign read after an allowed read': input => `cat ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/SKILL.md && cat /workspace/.env`,
    'foreign operation before an allowed read': input => `pwd && cat ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/SKILL.md`,
    'duplicate helper in one chain': input => Array(2).fill(`node ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/receipt.mjs ${input.phase}`).join(' && '),
    'foreign challenge in second helper': input => `node ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/receipt.mjs ${input.phase} && node ${input.fixture.workspace}/.agents/skills/${input.fixture.probe.name}/receipt.mjs ${randomUUID()}`,
    'extra helper argument in chain': input => `ls ${input.fixture.workspace}/.agents/skills && node ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/receipt.mjs ${input.phase} extra`,
    'foreign directory listing': () => 'ls -la /workspace',
    'unselected skill listing': input => `ls ${input.fixture.workspace}/.agents/skills/${input.fixture.added.name}`,
    'recursive listing flag': input => `ls -R ${input.fixture.workspace}/.agents/skills`,
    'two listing targets': input => `ls ${input.fixture.workspace}/.agents/skills /workspace`,
    'empty leading operation': input => `&& ls ${input.fixture.workspace}/.agents/skills`,
    'empty trailing operation': input => `ls ${input.fixture.workspace}/.agents/skills &&`,
    'empty middle operation': input => `ls ${input.fixture.workspace}/.agents/skills && && ls ${input.fixture.workspace}/.agents/skills`,
    'environment assignment': input => `NODE_OPTIONS=--inspect node ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/receipt.mjs ${input.phase}`,
    'environment executable': input => `env node ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/receipt.mjs ${input.phase}`,
    'nested wrapper': input => `/bin/bash -lc "cat ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/SKILL.md"`,
    'pipe': input => `cat ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/SKILL.md | cat`,
    'redirect': input => `cat ${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/SKILL.md > /workspace/.receipts/forged`,
    'or sequence': input => `ls ${input.fixture.workspace}/.agents/skills || ls /workspace`,
    'background execution': input => `ls ${input.fixture.workspace}/.agents/skills &`,
    'quoted substitution': () => 'cat "$(pwd)/.env"',
    'literal backtick substitution': () => 'cat `pwd`/.env',
    'path expansion': input => `cat ${input.fixture.workspace}/.agents/skills/*/SKILL.md`,
    'escaped space': () => 'cat /workspace/foreign\\ file',
    'newline': input => `ls ${input.fixture.workspace}/.agents/skills\npwd`,
    'unclosed quote': () => 'cat "unfinished',
};
for (const [name, corrupt] of Object.entries(chainCorruptions)) test(`wrapped approval rejects ${name}`, () => {
    const input = fixtureCase();
    command(input, `/bin/bash -lc '${corrupt(input)}'`);
    assert.throws(() => validateLiveSkillsApproval(input));
});

test('an existing current-phase receipt prevents approving that helper again without a prior UI decision', () => {
    const input = fixtureCase();
    input.snapshot.receipts = { [`${input.phase}-${input.fixture.control.name}.json`]: {} };
    assert.throws(() => validateLiveSkillsApproval(input), /already produced/);
});

test('native commandActions cannot disguise a forbidden real command', () => {
    const input = fixtureCase();
    changeDetail(input, detail => { detail.commandActions = [{ type: 'read', path: `${input.fixture.workspace}/.agents/skills/${input.fixture.control.name}/SKILL.md` }]; });
    command(input, '/bin/bash -lc \'cat /workspace/.env\'');
    assert.throws(() => validateLiveSkillsApproval(input), /escaped/);
});

test('wrapper changes, appended outer commands, oversized input and empty body reject', () => {
    const input = fixtureCase();
    for (const [value, reason] of [
        [`/bin/bash -c 'ls ${input.fixture.workspace}/.agents/skills'`, /Unexpected shell wrapper flags/],
        ["/bin/bash -lc ''", /Invalid approval command length/],
        [`/bin/bash -lc 'ls ${input.fixture.workspace}/.agents/skills' && cat /workspace/.env`, /exactly one command body/],
        ['x'.repeat(4097), /Invalid approval command length/],
    ]) assert.throws(() => parseLiveSkillsApprovalCommand(value), reason);
});

test('approval evidence follows the admitted root and the approved command uses the same canonical cwd', () => {
    const input = fixtureCase();
    assert.ok(!workspaceRoot.startsWith('/workspace'));
    assert.equal(validateLiveSkillsApproval(input).helper, input.fixture.control.name);
    const detail = JSON.parse(input.ui.detail);
    assert.equal(detail.cwd, input.fixture.workspace);
    assert.equal(input.snapshot.session.cwd, `${workspaceRoot}/${input.fixture.folder}`);
});

for (const [name, mutate] of Object.entries({
    'a missing root': input => { delete input.workspaceRoot; },
    'another root': input => { input.workspaceRoot = '/srv/other workspace'; },
    'a prefix-lookalike root': input => { input.workspaceRoot = `${workspaceRoot}-evil`; },
    'a session cwd on the retired alias': input => { input.snapshot.session.cwd = `/workspace/${input.fixture.folder}`; },
    'a native workspace under a lookalike root': input => { input.snapshot.native.workspace = `${workspaceRoot}-evil/${input.fixture.folder}`; },
    'a browser directory under another root': input => { input.browserURL = input.browserURL.replace(input.fixture.folder, `${workspaceRoot}-evil/${input.fixture.folder}`); },
})) {
    test(`approval rejects ${name}`, () => {
        const input = fixtureCase();
        mutate(input);
        assert.throws(() => validateLiveSkillsApproval(input));
    });
}

test('approval accepts the browser directory spelled as the fixture folder or its full same-path workspace', () => {
    const input = fixtureCase();
    input.browserURL = `${input.baseURL}/webchat?agent=roboTeamAgent&robot=${input.fixture.robotName}&workspace-dir=${encodeURIComponent(input.fixture.workspace)}`;
    assert.equal(validateLiveSkillsApproval(input).helper, input.fixture.control.name);
});

test('selected registered source files may be read while helper execution must use the installed link', () => {
    const input = fixtureCase();
    command(input, `cat ${input.fixture.repositoryRoot}/skills/${input.fixture.probe.name}/SKILL.md ${input.fixture.repositoryRoot}/skills/${input.fixture.probe.name}/receipt.mjs`);
    assert.equal(validateLiveSkillsApproval(input).helpers.length, 0);
    command(input, `node ${input.fixture.repositoryRoot}/skills/${input.fixture.probe.name}/receipt.mjs ${input.phase}`);
    assert.throws(() => validateLiveSkillsApproval(input), /escaped/);
});

test('literal canonical Unicode paths with spaces parse without permitting expansion', () => {
    assert.deepEqual(parseLiveSkillsApprovalCommand("cat '/Volumes/Ünïcode ws/ñ 数据 café/SKILL.md' && ls '/Volumes/Ünïcode ws/ñ 数据 café'").operations,
        [['cat', '/Volumes/Ünïcode ws/ñ 数据 café/SKILL.md'], ['ls', '/Volumes/Ünïcode ws/ñ 数据 café']]);
    assert.throws(() => parseLiveSkillsApprovalCommand("cat '/Volumes/Ünïcode ws/$HOME/SKILL.md'"));
});

for (const [name, corrupt] of Object.entries({
    'foreign settings-link robot': input => { input.settingsURL = input.settingsURL.replace(input.fixture.robotId, 'foreign-robot'); },
    'default browser robot': input => { input.browserURL = input.browserURL.replace(input.fixture.robotName, 'default'); },
    'foreign engine robot': input => { input.snapshot.session.engine.robotId = 'foreign-robot'; },
    'foreign registered source': input => { input.snapshot.robot.repository.source += '-decoy'; },
    'copied execution instead of live links': input => { input.snapshot.session.skillExecution.live = false; },
})) test(`current approval rejects ${name}`, () => {
    const input = fixtureCase(); corrupt(input);
    assert.throws(() => validateLiveSkillsApproval(input));
});
