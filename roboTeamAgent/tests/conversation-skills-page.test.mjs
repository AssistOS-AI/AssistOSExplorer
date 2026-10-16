import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const model = () => import('../public/conversation-skills-model.js');
const read = (name) => fs.readFile(path.join(PUBLIC_DIR, name), 'utf8');
const SID = 'caa7d510-d4a7-4e82-bb74-4c1b2e1c74fd';
const RID = 'default-abc123';
const context = { robotId: RID, sessionId: SID };

test('the path parser accepts exactly the page link below the public base and rejects everything else', async () => {
    const { parseConversationSkillsPath } = await model();
    const base = '/base-agent-additional-server/roboTeamAgent/3001/';
    assert.deepEqual(parseConversationSkillsPath(`${base}conversation-skills/${RID}/${SID}`, base), context);
    assert.deepEqual(parseConversationSkillsPath(`${base}conversation-skills/${RID}/${SID}/`, base), context);
    assert.deepEqual(parseConversationSkillsPath(`/conversation-skills/${RID}/${SID}`), context);
    assert.deepEqual(parseConversationSkillsPath(`/rt/conversation-skills/${'a'.repeat(64)}/${SID}`, '/rt/'), { robotId: 'a'.repeat(64), sessionId: SID });
    assert.deepEqual(parseConversationSkillsPath(`/rt/conversation-skills/abc/${SID}`, '/rt'), { robotId: 'abc', sessionId: SID });
    for (const pathname of ['/rt/conversation-skills', '/rt/conversation-skills/', `/rt/conversation-skills/${RID}`, `/rt/conversation-skills/${RID}/`,
        `/rt/conversation-skills/${RID}/${SID}/x`, `/rt/conversation-skills/${RID}/${SID}//`, `/rt/conversation-skills/${RID}/${SID.toUpperCase()}`,
        `/rt/conversation-skills/%2e%2e/${SID}`, `/rt/conversation-skills/${'a'.repeat(65)}/${SID}`, `/rt/conversation-skills/ab/${SID}`,
        `/rt/conversation-skills/Default/${SID}`, `/rt/conversation-skills/${RID}/not-a-uuid`, `/other/conversation-skills/${RID}/${SID}`,
        `/rt/x/conversation-skills/${RID}/${SID}`, null, undefined, 5]) {
        assert.equal(parseConversationSkillsPath(pathname, '/rt/'), null, String(pathname));
    }
});

test('the endpoint is the relative conversation skills API path of the parsed link', async () => {
    const { conversationSkillsEndpoint } = await model();
    assert.equal(conversationSkillsEndpoint(context), `api/robots/${RID}/conversations/${SID}/skills`);
});

test('normalization drops incomplete entries, marks required skills read-only and sorts by name then identity', async () => {
    const { normalizeConversationSkills } = await model();
    const skills = normalizeConversationSkills([
        { identity: 'b/zeta', name: 'zeta', description: 'Z', state: 'available', enabled: false },
        { identity: 'a/alpha', name: 'alpha', state: 'invalid', error: 'broken', enabled: false },
        { identity: 'c/alpha', name: 'alpha', state: 'available', enabled: true, required: true },
        { identity: 'd/beta', name: 'beta', state: 'shadowed', reason: 'shadowed by a/alpha', readOnly: true },
        { name: 'nameless-identity' }, { identity: 'no-name' }, null, 'text', { identity: '', name: 'empty' },
    ]);
    assert.deepEqual(skills.map(skill => skill.identity), ['a/alpha', 'c/alpha', 'd/beta', 'b/zeta']);
    assert.deepEqual(skills[0], { identity: 'a/alpha', name: 'alpha', description: '', state: 'invalid', enabled: false, readOnly: false, diagnostic: 'broken' });
    assert.equal(skills[1].readOnly, true);
    assert.equal(skills[1].enabled, true);
    assert.equal(skills[2].readOnly, true);
    assert.equal(skills[2].diagnostic, 'shadowed by a/alpha');
    assert.deepEqual(normalizeConversationSkills(undefined), []);
    assert.deepEqual(normalizeConversationSkills({ identity: 'x', name: 'x' }), []);
});

test('a catalog is applied only for the same robot, conversation scope and a current policy version', async () => {
    const { validateConversationCatalog } = await model();
    const good = { scope: 'conversation', sessionId: SID, robotId: RID, policyVersion: 3, skills: [] };
    assert.deepEqual(validateConversationCatalog(good, context, undefined), { ok: true });
    assert.deepEqual(validateConversationCatalog(good, context, 3), { ok: true });
    assert.deepEqual(validateConversationCatalog(good, context, 2), { ok: true });
    assert.deepEqual(validateConversationCatalog({ ...good, policyVersion: 2 }, context, 3), { ok: false, reason: 'stale' });
    for (const change of [{ scope: 'defaults' }, { scope: undefined }, { sessionId: crypto.randomUUID() }, { sessionId: null }, { robotId: 'other-abc123' },
        { robotId: undefined }, { policyVersion: -1 }, { policyVersion: 1.5 }, { policyVersion: '3' }, { policyVersion: 2 ** 53 }, { skills: {} }, { skills: undefined }]) {
        assert.deepEqual(validateConversationCatalog({ ...good, ...change }, context, 1), { ok: false, reason: 'invalid' }, JSON.stringify(change));
    }
    for (const payload of [null, undefined, 'x', [], 5]) assert.deepEqual(validateConversationCatalog(payload, context, 1), { ok: false, reason: 'invalid' });
    assert.deepEqual(validateConversationCatalog({ ...good, policyVersion: 0 }, context, undefined), { ok: true });
});

test('a mutation result must come from the same conversation and carry a strictly greater policy version', async () => {
    const { validateMutationCatalog } = await model();
    const result = { scope: 'conversation', sessionId: SID, robotId: RID, policyVersion: 4, skills: [] };
    assert.deepEqual(validateMutationCatalog(result, context, 3), { ok: true });
    assert.deepEqual(validateMutationCatalog({ ...result, policyVersion: 3 }, context, 3), { ok: false, reason: 'invalid' });
    assert.deepEqual(validateMutationCatalog({ ...result, scope: 'defaults' }, context, 3), { ok: false, reason: 'invalid' });
    assert.deepEqual(validateMutationCatalog({ ...result, sessionId: crypto.randomUUID() }, context, 3), { ok: false, reason: 'invalid' });
});

test('the toggle body has exactly the three fields the API accepts and disabling rules follow the policy', async () => {
    const { toggleRequestBody, toggleDisabled } = await model();
    const item = { identity: 'probe/probe-skill', name: 'probe-skill', state: 'available', enabled: false, readOnly: false, extra: 'ignored', dir: '/tmp' };
    assert.deepEqual(toggleRequestBody(item, 7), { identity: 'probe/probe-skill', enabled: true, policyVersion: 7 });
    assert.deepEqual(Object.keys(toggleRequestBody({ ...item, enabled: true }, 7)).sort(), ['enabled', 'identity', 'policyVersion']);
    assert.equal(toggleRequestBody({ ...item, enabled: true }, 7).enabled, false);
    const allowed = { busy: false, policyVersion: 7, mode: 'live' };
    assert.equal(toggleDisabled(item, allowed), false);
    assert.equal(toggleDisabled(item, { ...allowed, busy: true }), true);
    assert.equal(toggleDisabled(item, { ...allowed, policyVersion: undefined }), true);
    assert.equal(toggleDisabled(item, { ...allowed, policyVersion: 1.5 }), true);
    assert.equal(toggleDisabled(item, { ...allowed, mode: 'pinned' }), true);
    assert.equal(toggleDisabled({ ...item, readOnly: true }, allowed), true);
    assert.equal(toggleDisabled({ ...item, state: 'invalid' }, allowed), true);
});

test('status texts are the exported contract constants', async () => {
    const m = await model();
    assert.equal(m.INVALID_LINK, 'The conversation skills link is invalid. Open Conversation skills from the chat menu again.');
    assert.equal(m.LOADING, 'Loading conversation skills…');
    assert.equal(m.LOADED, 'Current selection loaded. Changes apply at the next execution.');
    assert.equal(m.SAVING, 'Saving skill selection…');
    assert.equal(m.INVALID_PAYLOAD, 'RoboTeam returned an invalid or mismatched skill policy. Refresh before changing settings.');
    assert.equal(m.STALE_RESPONSE, 'An older policy response was ignored. Refresh to load the current selection.');
    assert.equal(m.failureText('skill policy changed; reload before updating'), 'skill policy changed; reload before updating Refresh to load the current policy.');
});

test('the summary names the robot, conversation, policy version, counts and diagnostics as text lines', async () => {
    const { conversationSummaryLines, normalizeConversationSkills } = await model();
    const skills = normalizeConversationSkills([{ identity: 'a/one', name: 'one', enabled: true, state: 'available' }, { identity: 'a/two', name: 'two', enabled: false, state: 'available' }]);
    const lines = conversationSummaryLines({ robotName: 'default', sessionId: SID, policyVersion: 4, skills, diagnostics: [{ state: 'unavailable', message: '<script>x</script>' }] });
    assert.deepEqual(lines, ['Robot: default', `Conversation: ${SID}`, 'Policy version: 4', 'Skills: 2', 'Enabled: 1', 'Diagnostic: <script>x</script>']);
});

test('the browser wiring renders only through textContent and loads through the mutation-proof client', async () => {
    const source = await read('conversation-skills.js');
    assert.doesNotMatch(source, /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\b|new Function|createContextualFragment/);
    assert.match(source, /textContent/);
    assert.match(source, /from '\.\/roboflow-api\.js'/);
    assert.match(source, /from '\.\/conversation-skills-model\.js'/);
    assert.match(source, /parseConversationSkillsPath\(/);
    assert.doesNotMatch(source, /\bfetch\(/);
    assert.doesNotMatch(source, /[?&]dir=|cwd/);
    const modelSource = await read('conversation-skills-model.js');
    assert.doesNotMatch(modelSource, /\bdocument\b|\bwindow\b|\blocation\b/);
});

test('the page shell carries the DOM contract ids, the base-relative assets and the inline theme initialization', async () => {
    const html = await read('conversation-skills.html');
    assert.match(html, /<link rel="stylesheet" href="styles\.css">/);
    assert.match(html, /<script src="config\.js"><\/script>/);
    assert.match(html, /<script type="module" src="conversation-skills\.js"><\/script>/);
    assert.match(html, /assistosExplorerTheme/);
    assert.match(html, /<[a-z0-9]+[^>]*id="conversationSkillsStatus"[^>]*role="status"[^>]*aria-live="polite"|<[a-z0-9]+[^>]*role="status"[^>]*aria-live="polite"[^>]*id="conversationSkillsStatus"/);
    assert.match(html, /id="conversationSkillsSummary"/);
    assert.match(html, /<button[^>]*id="conversationSkillsRefresh"[^>]*>\s*Refresh skills\s*<\/button>/);
    assert.match(html, /<ul[^>]*id="conversationSkillsList"[^>]*data-loaded="false"/);
    assert.doesNotMatch(html, /<base[\s>]/);
    assert.doesNotMatch(html, /\sonclick=|javascript:/i);
});
