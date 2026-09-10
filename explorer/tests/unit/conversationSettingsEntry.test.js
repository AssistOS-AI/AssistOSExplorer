import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { FileExp } from '../../web-components/pages/file-exp/file-exp.js';
import { attachSearchController } from '../../web-components/pages/file-exp/file-exp-search.js';
import { consumeConversationSettingsRequest } from '../../web-components/pages/file-exp/conversation-settings-route.mjs';
import { SettingsModal } from '../../web-components/modals/settings-modal/settings-modal.js';
import { completeInitialApplicationRoute } from '../../services/runtime/initial-application-route.js';

const sessionId = 'caa7d510-d4a7-4e82-bb74-4c1b2e1c74fd';
const skill = { identity: 'workspace:Repo/.agents/skills/Example', name: 'Example', enabled: false, state: 'disabled' };

test('production Explorer entrypoint opens conversation Settings, persists its toggle, then ordinary Settings edits defaults', async (t) => {
    const originalWindow = globalThis.window;
    const originalAssistOS = globalThis.assistOS;
    t.after(() => { globalThis.window = originalWindow; globalThis.assistOS = originalAssistOS; });
    let url = new URL(`/explorer/index.html?copilot-robot=Research+%26+Review&copilot-session=${sessionId}&dir=/wrong/browser/cwd#file-exp/other-repo`, 'https://workspace.example');
    const calls = [];
    const modals = [];
    const saved = { conversation: false, defaults: false };
    globalThis.window = {
        get location() { return url; },
        history: { replaceState(_state, _title, next) { url = new URL(next, url); } },
        webSkel: { appServices: { getClient(agent) {
            assert.equal(agent, 'roboTeamAgent');
            return { async callTool(name, args) {
                calls.push({ name, args });
                const scope = args.sessionId ? 'conversation' : 'defaults';
                if (name === 'set_achilles_skill_enabled') saved[scope] = args.enabled;
                return { scope, policyVersion: saved[scope] ? 4 : 3, skills: [{ ...skill, enabled: saved[scope] }],
                    activeRevision: scope === 'conversation' ? { revision: 'active-before-change' } : null };
            } };
        } } },
    };
    globalThis.assistOS = { UI: { async createReactiveModal(name, props) {
        assert.equal(name, 'settings-modal');
        const modal = new SettingsModal({}, () => {}, props);
        modal.copilotSettingsListEl = { innerHTML: '' };
        modals.push(modal);
        await modal.loadCopilotSettingsData();
        await modal.toggleCopilotSkill(null, 0);
        return null;
    } } };
    const fileExp = Object.assign(Object.create(FileExp.prototype), {
        element: { querySelector() { return null; } },
        state: { path: '/wrong/browser/cwd' },
        setSearchMenuOpen() {}, setWindowListener() {}, removeDocumentListener() {},
        boundLoadStateFromURL: async () => {},
        showStatus(message) { assert.fail(message); },
    });
    attachSearchController(fileExp);
    await fileExp.applyInitialLocationRoute();
    const toolServices = window.webSkel;
    delete window.webSkel;
    await completeInitialApplicationRoute({ webSkel: toolServices, presenter: fileExp });
    assert.equal(modals.length, 1);
    assert.deepEqual(modals[0].props.copilotContext, { robot: 'Research & Review', sessionId });
    assert.equal(modals[0].props.tab, 'copilot');
    assert.deepEqual(calls[0].args, { robot: 'Research & Review', sessionId });
    assert.deepEqual(calls[1].args, { robot: 'Research & Review', sessionId, identity: skill.identity, enabled: true, policyVersion: 3 });
    assert.match(modals[0].copilotSettingsListEl.innerHTML, /Active execution revision: active-before-change/);
    assert.equal(url.searchParams.has('copilot-session'), false);
    assert.equal(url.searchParams.get('dir'), '/wrong/browser/cwd');
    await fileExp.applyInitialLocationRoute();
    assert.equal(modals.length, 1);
    await fileExp.openSettingsModal(null, 'copilot');
    assert.equal(modals[1].props.copilotContext, undefined);
    assert.deepEqual(calls[2].args, { robot: 'default' });
    assert.deepEqual(calls[3].args, { robot: 'default', identity: skill.identity, enabled: true, policyVersion: 3 });
    assert.deepEqual(saved, { conversation: true, defaults: true });
    const bootstrap = await fs.readFile(new URL('../../main.js', import.meta.url), 'utf8');
    assert.match(bootstrap, /const mountedPresenter = await mountInitialApplicationRoute\(/);
    assert.match(bootstrap, /void completeInitialApplicationRoute\(\{ webSkel, presenter: mountedPresenter \}\)/);
});

test('malformed, duplicate or incomplete conversation routes fail instead of opening defaults', () => {
    for (const search of [`?copilot-session=${sessionId}`, '?copilot-robot=default',
        `?copilot-session=${sessionId}&copilot-robot=`, '?copilot-session=bad&copilot-robot=default',
        `?copilot-session=${sessionId}&copilot-robot=default&copilot-robot=other`]) {
        let consumed = false;
        assert.throws(() => consumeConversationSettingsRequest({ pathname: '/explorer/index.html', search }, {
            replaceState(_state, _title, result) { consumed = true; assert.equal(result, '/explorer/index.html'); },
        }), /conversation settings link is invalid/);
        assert.equal(consumed, true);
    }
    assert.equal(consumeConversationSettingsRequest({ search: '?unrelated=1' }), null);
});
