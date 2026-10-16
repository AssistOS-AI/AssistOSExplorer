import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { skillRepositoryLabel } from '../public/skills-dialog.js';

const source = await readFile(new URL('../public/skills-dialog.js', import.meta.url), 'utf8');
const manager = source.slice(source.indexOf('export function openSkillsDialog'), source.indexOf('const CODING_AGENT_LABELS'));
const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

test('repository labels use readable names without exposing paths in the sidebar', () => {
    assert.equal(skillRepositoryLabel({ builtin: true }), 'Built-in copilot');
    assert.equal(skillRepositoryLabel({ id: 'r', source: '/workspace/my-skills/' }), 'my-skills');
    assert.equal(skillRepositoryLabel({ id: 'r', source: 'https://github.com/team/my-skills.git' }), 'my-skills');
    assert.equal(skillRepositoryLabel({ id: 'r', source: '' }), 'r');
    assert.equal(skillRepositoryLabel({ id: 'r', source: '/workspace/Project/skills' }, [
        { name: 'Project', source: '/workspace/Project', kind: 'mixed' },
    ]), 'Project');
    assert.equal(skillRepositoryLabel({ id: 'r', source: '/workspace/.ploinky/repos/Project' }, [
        { name: 'Project', source: '/workspace/Project', kind: 'skills' },
    ]), 'Project');
});

test('the manager keeps a discreet add action in the navigation heading and opens a separate dialog', () => {
    assert.match(manager, /class="skills-repository-nav" aria-label="Skill repositories"/);
    for (const id of ['skills-repository-panel', 'skills-required-panel']) {
        assert.ok(manager.includes(`id="${id}"`), id);
    }
    assert.match(manager, /data-skills-view="required"/);
    const nav = manager.slice(manager.indexOf('<nav'), manager.indexOf('</nav>'));
    assert.match(nav, /class="skills-repository-nav-heading"[\s\S]*class="skills-add-option"/);
    assert.match(nav, /aria-haspopup="dialog" aria-controls="skills-add-dialog" aria-expanded="false"/);
    assert.match(manager, /addDialog = document\.createElement\('dialog'\)/);
    assert.match(manager, /addDialog\.id = 'skills-add-dialog'/);
    assert.match(manager, /class="button secondary close-add-repository">Close<\/button>/);
    assert.doesNotMatch(manager, /cancel-add-repository|>Cancel<\/button>/);
    assert.match(manager, /dialog\.append\(addDialog\)/);
    assert.doesNotMatch(manager, /skills-manager-toolbar|skills-add-panel|data-skills-view="add"/);
    assert.match(manager, /class="skills-manager-footer"[\s\S]*role="status" aria-live="polite"/);
    assert.doesNotMatch(manager, /class="repository-row"|Skills in this skillset/);
});

test('skill names stay inside their skillset, with only ungrouped skills listed separately', () => {
    assert.match(manager, /item\.append\(skillList\(set\.skills, `Skills included in/);
    assert.match(manager, /new Set\(sets\.flatMap\(set => set\.skills\)\)/);
    assert.match(manager, /repo\.skills\.filter\(skill => !grouped\.has\(skill\.name\)\)/);
    assert.match(manager, /sets\.length \? 'Other skills' : 'Skills'/);
    assert.doesNotMatch(manager, /skill\.description/);
    assert.match(manager, /input\.setAttribute\('role', 'switch'\)/);
    assert.match(manager, /input\.disabled = busy \|\| !canAdmin/);
    assert.match(manager, /mutate\('PATCH', \{ id: set\.id, enabled: input\.checked \}\)/);
});

test('administrator mutations retain the existing API and built-in sources cannot be removed', () => {
    assert.match(manager, /if \(busy \|\| !canAdmin \|\| lifetime\.signal\.aborted\) return/);
    assert.match(manager, /if \(canAdmin && !repo\.builtin\)/);
    assert.match(manager, /initRobotMenu\(\{ menu,/);
    assert.match(manager, /mutate\('DELETE', \{ name: repo\.id \}\)/);
    assert.match(manager, /\?name=\$\{encodeURIComponent\(body\.name\)\}/);
    assert.match(manager, /method === 'DELETE' \? \{ method \} : \{ method, body \}/);
    assert.match(manager, /addTrigger\.hidden = !canAdmin/);
});

test('mutations preserve selection, open the newly added source and leave required skill reads view-only', () => {
    assert.match(manager, /selectedId = added\.id; view = 'repository'/);
    assert.match(manager, /if \(!repos\.some\(repo => repo\.id === selectedId\)\) selectedId = repos\[0\]\?\.id/);
    assert.match(manager, /const updated = result\.robots\.find/);
    assert.ok(manager.indexOf('if (!updated) throw') < manager.indexOf('current = updated'));
    assert.match(manager, /const scrollTop = contentPane\.scrollTop/);
    assert.match(manager, /contentPane\.scrollTop = scrollTop/);
    assert.match(manager, /target\?\.focus\(\{ preventScroll: true \}\)/);
    assert.match(manager, /api\('api\/required-skills', \{ signal: lifetime\.signal \}\)/);
    assert.match(manager, /if \(lifetime\.signal\.aborted\) return/);
    assert.match(manager, /Required · View only/);
});

test('the manager uses only existing RoboTeam color tokens and collapses to one column', () => {
    const styles = css.slice(css.indexOf('.skills-manager-dialog[open]'), css.indexOf('.muted {'));
    assert.doesNotMatch(styles, /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i);
    assert.match(styles, /background: var\(--surface-soft\)/);
    assert.match(styles, /color: var\(--accent\); background: var\(--bg-active\)/);
    assert.match(styles, /accent-color: var\(--accent\)/);
    assert.match(styles, /\.skillset-item > \.skill-members \{[^}]*border-top: 1px solid var\(--border\)/);
    assert.match(css, /\.skills-manager-layout \{ grid-template-columns: minmax\(0, 1fr\); grid-template-rows: auto minmax\(0, 1fr\)/);
    assert.match(styles, /\.skills-manager-content \{[^}]*overflow: auto/);
    assert.match(styles, /\.skills-manager-footer \{ flex-shrink: 0/);
    assert.match(styles, /\.skills-repository-nav-heading \{[^}]*justify-content: space-between/);
    assert.doesNotMatch(css, /\.skills-add-option \{[^}]*margin-top: auto/);
});

test('the add popup preserves the selected view, contains errors, blocks duplicate submissions and closes independently', () => {
    assert.match(manager, /initCreateRobotDialog\(\{\s*dialog: addDialog, trigger: addTrigger/);
    assert.match(manager, /addController\.setBusy\(busy\)/);
    assert.match(manager, /addController\.complete\(\)/);
    assert.match(manager, /addDialog\.addEventListener\('cancel', event => event\.stopPropagation\(\)\)/);
    assert.match(manager, /addDialog\.open \? addMessage : message/);
    assert.match(manager, /if \(addDialog\.open\) addDialog\.close\(\)/);
    assert.match(manager, /addDialog\.addEventListener\('close', \(\) => addTrigger\.setAttribute\('aria-expanded', 'false'\)\)/);
    assert.match(css, /\.skills-add-dialog \{[^}]*max-height: min\(720px, calc\(100dvh - 48px\)\)/);
    assert.match(css, /\.skills-add-content \{[^}]*overflow: auto/);
});
