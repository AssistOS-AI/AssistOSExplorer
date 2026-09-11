import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCopilotController, normalizeCopilotSkillItems } from '../../web-components/modals/settings-modal/settings-copilot-controller.js';

const explorerRoot = path.resolve(import.meta.dirname, '../..');
const skill = { identity: 'workspace:Repo/.agents/skills/Example', name: 'Example', enabled: false, state: 'disabled', sourcePath: '/workspace/Repo/.agents/skills/Example' };
const catalog = (version = 3, extra = {}) => ({ skills: [skill], scope: 'defaults', policyVersion: version, policy: { mode: 'live' }, activeRevision: null, diagnostics: [], ...extra });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function controller(tool, copilotContext) {
    return Object.assign({ props: { copilotContext }, state: { copilotItems: [] }, copilotSettingsListEl: { innerHTML: '' } }, createCopilotController(tool));
}

test('Copilot settings use the owning robot catalog and server-backed selection', async () => {
    const calls = [];
    const subject = controller(async (agent, name, args) => {
        calls.push({ agent, name, args });
        return name === 'list_achilles_skills' ? catalog() : catalog(4, { skills: [{ ...skill, enabled: true, state: 'active' }] });
    });
    await subject.loadCopilotSettingsData();
    assert.deepEqual(calls[0], { agent: 'roboTeamAgent', name: 'list_achilles_skills', args: { robot: 'default' } });
    assert.equal(subject.state.copilotItems[0].enabled, false);
    assert.match(subject.copilotSettingsListEl.innerHTML, /Robot default defaults/);
    assert.match(subject.copilotSettingsListEl.innerHTML, /Effective selection: 0/);
    await subject.toggleCopilotSkill(null, '0');
    assert.deepEqual(calls[1].args, { robot: 'default', identity: skill.identity, enabled: true, policyVersion: 3 });
    assert.equal(subject.state.copilotPolicyVersion, 4);
    assert.equal(subject.state.copilotItems[0].enabled, true);
    const handlers = await fs.readFile(path.join(explorerRoot, 'utils/server/tool-handlers.mjs'), 'utf8');
    assert.doesNotMatch(handlers, /discoverSkills|achillesAgentLib|AchillesCLI.*node_modules/);
    const mcpConfig = JSON.parse(await fs.readFile(path.join(explorerRoot, 'mcp-config.json'), 'utf8'));
    assert.equal(mcpConfig.tools.some((tool) => tool.name === 'list-skills'), false);
});

test('conversation settings use the named robot/session and saved cwd authority', async () => {
    const calls = [];
    const subject = controller(async (_agent, _name, args) => {
        calls.push(args);
        return catalog(8, { scope: 'conversation', activeRevision: { revision: 'active-old', policyVersion: 7 } });
    }, { robot: 'research', sessionId: 'session-1', dir: '/wrong/browser/cwd' });
    await subject.loadCopilotSettingsData();
    await subject.toggleCopilotSkill(null, 0);
    assert.deepEqual(calls[0], { robot: 'research', sessionId: 'session-1' });
    assert.deepEqual(calls[1], { robot: 'research', sessionId: 'session-1', identity: skill.identity, enabled: true, policyVersion: 8 });
    assert.match(subject.copilotSettingsListEl.innerHTML, /Conversation session-1/);
    assert.match(subject.copilotSettingsListEl.innerHTML, /Active execution revision: active-old/);
});

test('late read cannot overwrite a mutation or a changed conversation context', async () => {
    const pending = deferred();
    let reads = 0;
    const subject = controller(async (_agent, name) => name === 'list_achilles_skills'
        ? (++reads === 1 ? catalog() : pending.promise)
        : catalog(4, { skills: [] }));
    await subject.loadCopilotSettingsData();
    const read = subject.loadCopilotSettingsData();
    await subject.toggleCopilotSkill(null, 0);
    pending.resolve(catalog());
    await read;
    assert.equal(subject.state.copilotPolicyVersion, 4);
    assert.deepEqual(subject.state.copilotItems, []);
    const other = deferred();
    const switching = controller(() => other.promise);
    const wait = switching.loadCopilotSettingsData();
    switching.props.copilotContext = { sessionId: 'another-session' };
    other.resolve(catalog());
    await wait;
    assert.deepEqual(switching.state.copilotItems, []);
});

test('explicit empty policy stays empty, stale versions ignored, and failed mutations do not fake a toggle', async () => {
    const subject = controller(async () => catalog(5, { skills: [], policy: { selectors: { sources: [], skills: [] } } }));
    await subject.loadCopilotSettingsData();
    assert.deepEqual(subject.state.copilotPolicy.selectors.sources, []);
    assert.equal(subject.applyCopilotCatalog(catalog(4), { robot: 'default' }), false);
    assert.deepEqual(subject.state.copilotItems, []);
    const failing = controller(async (_agent, name) => {
        if (name === 'list_achilles_skills') return catalog();
        throw new Error('Policy version conflict');
    });
    await failing.loadCopilotSettingsData();
    await failing.toggleCopilotSkill(null, 0);
    assert.equal(failing.state.copilotItems[0].enabled, false);
    assert.match(failing.state.copilotStatus, /Policy version conflict/);
    assert.equal(failing.state.copilotBusy, false);
});

test('catalog identity case is preserved, untrusted labels escaped and invalid entries disabled', async () => {
    assert.equal(normalizeCopilotSkillItems([skill])[0].identity, skill.identity);
    const subject = controller(async () => catalog(1, {
        skills: [{ ...skill, name: '<img src=x onerror=alert(1)>', sourcePath: '<script>', state: 'invalid' }],
        diagnostics: [{ reason: '<unreadable>' }]
    }));
    await subject.loadCopilotSettingsData();
    assert.doesNotMatch(subject.copilotSettingsListEl.innerHTML, /<img|<script>/);
    assert.match(subject.copilotSettingsListEl.innerHTML, /&lt;unreadable&gt;/);
    assert.match(subject.copilotSettingsListEl.innerHTML, /aria-pressed="false" disabled/);
});

test('mismatched defaults response does not get presented as conversation selection', async () => {
    const subject = controller(async () => catalog(), { sessionId: 'session-1' });
    await subject.loadCopilotSettingsData();
    assert.equal(subject.state.copilotStatusType, 'error');
    assert.equal(subject.state.copilotPolicyVersion, undefined);
});


test('older catalog responses cannot leave the view spinning or overwrite current policy', async () => {
    let version = 5;
    const subject = controller(async () => catalog(version));
    await subject.loadCopilotSettingsData();
    version = 4;
    await subject.loadCopilotSettingsData();
    assert.equal(subject.state.copilotPolicyVersion, 5);
    assert.equal(subject.state.copilotStatusType, 'error');
    assert.match(subject.state.copilotStatus, /older catalog response was ignored/);
});
