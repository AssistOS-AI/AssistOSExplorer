import assert from 'node:assert/strict';
import { conversationFromSettingsURL, liveSkillSources, liveSkillsPrompt, liveSkillsHash } from './copilot-live-skills.mjs';

function literalTokens(command) {
    assert.ok(typeof command === 'string' && command.length > 0 && command.length <= 4096, 'Invalid approval command length.');
    // A deliberately small shell subset: literal words/quotes and &&. Reject
    // expansions and escapes even inside quotes, before interpreting any text.
    assert.match(command, /^[A-Za-z0-9_./ &'"-]+$/, 'Approval contains unsupported shell syntax.');
    const tokens = [];
    let word = '', quote = null, started = false;
    const flush = () => {
        if (started) tokens.push({ word });
        word = ''; started = false;
    };
    for (let index = 0; index < command.length; index++) {
        const char = command[index];
        if (quote) {
            if (char === quote) quote = null;
            else word += char;
        } else if (char === "'" || char === '"') {
            quote = char; started = true;
        } else if (char === ' ') flush();
        else if (char === '&') {
            assert.equal(command[++index], '&', 'Only && sequencing is supported.');
            flush(); tokens.push({ and: true });
        } else { word += char; started = true; }
    }
    assert.equal(quote, null, 'Unclosed approval command quote.');
    flush();
    assert.ok(tokens.length > 0 && tokens.length <= 128, 'Invalid approval token count.');
    return tokens;
}

export function parseLiveSkillsApprovalCommand(command) {
    let tokens = literalTokens(command);
    let shell = null;
    if (tokens[0].word === '/bin/bash') {
        assert.equal(tokens.length, 3, 'The shell wrapper must contain exactly one command body.');
        assert.equal(tokens[1].word, '-lc', 'Unexpected shell wrapper flags.');
        assert.equal(typeof tokens[2].word, 'string');
        shell = '/bin/bash -lc';
        tokens = literalTokens(tokens[2].word);
    }
    const operations = [[]];
    for (const token of tokens) {
        if (token.and) {
            assert.ok(operations.at(-1).length > 0, 'Empty approval command in sequence.');
            operations.push([]);
        } else {
            assert.ok(token.word.length > 0, 'Empty approval argument.');
            operations.at(-1).push(token.word);
        }
    }
    assert.ok(operations.at(-1).length > 0 && operations.length <= 12, 'Invalid approval command sequence.');
    return { shell, operations };
}

export function validateLiveSkillsApproval({ ui, browserURL, settingsURL, baseURL, snapshot, fixture,
    sessionId, phase, selected, baselineIds, decisions, nativeIdentity }) {
    assert.equal(conversationFromSettingsURL(settingsURL, baseURL), sessionId, 'Approval changed browser conversation.');
    const url = new URL(browserURL);
    assert.equal(url.origin, new URL(baseURL).origin);
    assert.equal(url.pathname, '/webchat');
    assert.equal(url.searchParams.get('agent'), 'roboTeamAgent');
    assert.equal(url.searchParams.get('robot'), 'default');
    const directory = url.searchParams.get('workspace-dir') || url.searchParams.get('dir');
    assert.ok([fixture.folder, fixture.workspace].includes(directory), 'Approval changed browser workspace.');
    assert.equal(snapshot.session.sessionId, sessionId);
    assert.equal(snapshot.session.cwd, fixture.workspace);
    assert.equal(snapshot.native.id, sessionId);
    assert.equal(snapshot.native.workspace, fixture.workspace);
    assert.equal(snapshot.native.agent, 'codex');
    if (nativeIdentity) assert.deepEqual({ sessionId, home: snapshot.native.home, workspace: snapshot.native.workspace,
        agent: snapshot.native.agent, threadId: snapshot.native.continuation.threadId }, nativeIdentity,
    'Approval changed the continuing native conversation.');
    assert.equal(snapshot.session.skillExecution.active, true, 'Approval requires the currently active native turn.');
    const pending = snapshot.session.messages.filter(message => message.role === 'assistant' && !baselineIds.includes(message.id));
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'pending');
    const users = snapshot.session.messages.filter(message => message.role === 'user' && message.turnId === pending[0].turnId);
    assert.equal(users.length, 1);
    assert.equal(users[0].text, liveSkillsPrompt({ phase, selected }));
    assert.equal(ui.title, 'Codex permission request');
    const detail = JSON.parse(ui.detail);
    assert.equal(detail.threadId, snapshot.native.continuation.threadId, 'Approval belongs to another native conversation.');
    assert.match(detail.turnId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(detail.cwd, '/workspace');
    assert.equal(detail.item?.type, 'commandExecution', 'Only a concrete native command can be approved.');
    assert.ok(typeof detail.itemId === 'string' && detail.itemId.length > 0);
    assert.equal(detail.item.id, detail.itemId);
    assert.equal(detail.item.cwd, '/workspace');
    assert.equal(detail.item.command, detail.command);
    assert.equal(detail.permissions, undefined, 'Permission profile grants are outside this gate.');
    const activeRevision = snapshot.session.skillExecution.revision;
    assert.equal(snapshot.catalog.revision, activeRevision);
    const files = new Map();
    for (const skill of selected) {
        const source = liveSkillSources(fixture, skill);
        assert.deepEqual(snapshot.capturedFiles[skill.name], { descriptorSha256: source.descriptorSha256, helperSha256: source.helperSha256 });
        const entry = snapshot.catalog.entries.filter(entry => entry.name === skill.name);
        assert.equal(entry.length, 1);
        assert.equal(entry[0].identity, `workspace:${fixture.folder}/.agents/skills/${skill.name}`);
        assert.ok(snapshot.session.skillExecution.resolvedSkills.includes(entry[0].identity));
        files.set(`/workspace/.agents/skills/${skill.name}/SKILL.md`, { skill: skill.name, helper: false });
        files.set(`/workspace/.agents/skills/${skill.name}/receipt.mjs`, { skill: skill.name, helper: true });
    }
    // Native commandActions can be "unknown" for a compound command. They are
    // diagnostic metadata, never authority to approve an unchecked operation.
    const parsed = parseLiveSkillsApprovalCommand(detail.command);
    const helpers = [];
    const approvedHelpers = new Set(decisions.flatMap(decision => decision.helpers || (decision.helper ? [decision.helper] : [])));
    const directories = new Set(['/workspace/.agents/skills', ...selected.map(skill => `/workspace/.agents/skills/${skill.name}`)]);
    for (const argv of parsed.operations) {
        if (argv[0] === 'cat') {
            assert.ok(argv.length > 1 && argv.slice(1).every(file => files.has(file)), 'Read escaped the selected skill sources.');
        } else if (argv[0] === 'ls') {
            assert.ok(argv.length >= 2 && argv.length <= 4 && directories.has(argv.at(-1))
                && argv.slice(1, -1).every(flag => ['-a', '-l', '-la', '-al'].includes(flag)),
            'Listing escaped the selected skill directories or used unsupported flags.');
        } else {
            assert.equal(argv[0], 'node', 'Unexpected native executable.');
            assert.equal(argv.length, 3);
            assert.equal(argv[2], phase, 'Helper approval used a different phase challenge.');
            assert.equal(files.get(argv[1])?.helper, true, 'Execution escaped the selected receipt helper.');
            const helper = files.get(argv[1]).skill;
            assert.ok(!approvedHelpers.has(helper) && !helpers.includes(helper), 'The helper was already approved in this phase.');
            assert.ok(!Object.hasOwn(snapshot.receipts || {}, `${phase}-${helper}.json`), 'The helper already produced its phase receipt.');
            helpers.push(helper);
        }
    }
    assert.ok(Array.isArray(ui.options) && ui.options.length > 0);
    const allowed = ui.options.filter(option => option.label === 'Allow once' && option.description === 'Approve this operation.');
    assert.equal(allowed.length, 1, 'One explicit single-operation approval is required.');
    const match = allowed[0].id.match(/^interaction-option-(task_control_[0-9a-f_]{36})-(\d+)$/);
    assert.ok(match, 'Approval lacks the normal interaction identity.');
    const interactionId = match[1];
    assert.ok(!decisions.some(decision => decision.interactionId === interactionId), 'Approval interaction was replayed.');
    assert.ok(ui.options.every((option, index) => option.id === `interaction-option-${interactionId}-${index}`));
    assert.ok(decisions.length < 12, 'Unexpected approval count in one native turn.');
    return { interactionId, buttonId: allowed[0].id, optionId: `choice_${match[2]}`, decision: 'accept',
        nativeThreadId: detail.threadId, nativeTurnId: detail.turnId, turnId: pending[0].turnId,
        command: detail.command, commandSha256: liveSkillsHash(detail.command), revision: activeRevision,
        ...parsed, helpers, helper: helpers.length === 1 ? helpers[0] : null };
}

export async function approveLiveSkillsRequest({ page, remaining, evidence, ...binding }) {
    const prompt = page.locator('#interactionPrompt');
    if (!await prompt.isVisible()) return;
    const ui = await prompt.evaluate(root => ({
        title: root.querySelector('#interactionPromptTitle')?.textContent,
        detail: root.querySelector('#interactionPromptDetail')?.textContent,
        options: [...root.querySelectorAll('#interactionPromptOptions button')].map(button => ({ id: button.id,
            label: button.querySelector('span')?.textContent,
            description: button.querySelector('.wa-interaction-option-description')?.textContent || '' })),
    }));
    evidence.pendingApproval = ui;
    const decision = validateLiveSkillsApproval({ ...binding, ui, browserURL: page.url(),
        settingsURL: await page.locator('#sessionSettingsLink').getAttribute('href'), decisions: evidence.approvals });
    const beforeURL = new URL(page.url());
    const response = page.waitForResponse(response => {
        const url = new URL(response.url());
        if (url.origin !== beforeURL.origin || url.pathname !== '/webchat/interaction' || response.request().method() !== 'POST') return false;
        if (![...beforeURL.searchParams].every(([name, value]) => url.searchParams.get(name) === value)) return false;
        const body = response.request().postDataJSON();
        return body?.interactionId === decision.interactionId && body.optionId === decision.optionId
            && Object.keys(body).sort().join(',') === 'interactionId,optionId';
    }, { timeout: remaining() });
    const [accepted] = await Promise.all([response, page.locator(`#${decision.buttonId}`).click({ timeout: remaining() })]);
    assert.equal(accepted.status(), 204, 'The normal UI approval was not accepted.');
    evidence.approvals.push({ ...decision, at: new Date().toISOString() });
    await page.locator(`#${decision.buttonId}`).waitFor({ state: 'detached', timeout: remaining() });
    delete evidence.pendingApproval;
}
