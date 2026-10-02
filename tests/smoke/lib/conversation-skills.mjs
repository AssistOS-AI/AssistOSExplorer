import assert from 'node:assert/strict';

import { expect } from './fixtures.mjs';
import { UUID } from './copilot-live-skills.mjs';

// Smoke helpers for RoboTeam's Conversation skills page and API. The page and the two-verb API are served
// by the RoboTeam agent under its Router route; Explorer has no skill settings surface.
export const ROBOTEAM_BASE_PATH = '/base-agent-additional-server/roboTeamAgent/3001/';
const ROBOTEAM_ROUTE_KEY = 'roboTeamAgent';
const ROBOT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const API_PATH = /^api\/[A-Za-z0-9._~%/-]*(?:\?[A-Za-z0-9._~%&=+-]*)?$/;
const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);
const LOADED_TEXT = 'Current selection loaded. Changes apply at the next execution.';
const LIST = '#conversationSkillsList';
const ROWS = `${LIST} > li.conversation-skill-row`;
const STATUS = '#conversationSkillsStatus';

// Returns the robot id and conversation UUID of a RoboTeam Conversation skills link. The link must be the
// canonical root-relative or same-origin URL, with no query string and no fragment, so it can never carry a cwd.
export function conversationFromSkillsURL(value, origin, { robotId } = {}) {
    assert.equal(typeof value, 'string', 'The Conversation skills link is missing.');
    const base = new URL(origin);
    const url = new URL(value, base);
    assert.equal(url.origin, base.origin, 'Conversation skills escaped the selected application origin.');
    assert.equal(value, value.startsWith('/') ? url.pathname : url.href, 'The Conversation skills link is not canonical.');
    assert.equal(url.search, '', 'The Conversation skills link must not carry a query string.');
    assert.equal(url.hash, '', 'The Conversation skills link must not carry a fragment.');
    const prefix = `${ROBOTEAM_BASE_PATH}conversation-skills/`;
    assert.ok(url.pathname.startsWith(prefix), 'The Conversation skills link is not a RoboTeam page.');
    const segments = url.pathname.slice(prefix.length).split('/');
    assert.equal(segments.length, 2, 'The Conversation skills link must name one robot and one conversation.');
    const [linkRobotId, sessionId] = segments;
    assert.match(linkRobotId, ROBOT_ID, 'The Conversation skills link has an invalid robot id.');
    assert.match(sessionId, UUID, 'The browser must identify one actual conversation UUID.');
    if (robotId !== undefined) assert.equal(linkRobotId, robotId, 'The Conversation skills link names another robot.');
    return { robotId: linkRobotId, sessionId };
}

// Calls a RoboTeam API path (relative to its base, for example `api/robots`) from a page under the RoboTeam
// route. Mutations carry the Ploinky browser mutation proof of the roboTeamAgent route. Non-2xx replies are
// returned, not thrown, so callers can assert on 409 and similar answers.
export async function roboTeamApi(page, { method = 'GET', path, body } = {}) {
    const verb = String(method).toUpperCase();
    assert.ok(METHODS.has(verb), `Unsupported RoboTeam API method ${method}.`);
    assert.ok(typeof path === 'string' && API_PATH.test(path) && !/(?:^|[/?])\.\.?(?:[/?]|$)/.test(path) && !/%2[ef]/i.test(path),
        `Not a RoboTeam API path: ${path}`);
    const here = new URL(page.url());
    assert.ok(here.pathname.startsWith(ROBOTEAM_BASE_PATH), 'roboTeamApi must run on a RoboTeam page.');
    return page.evaluate(async ({ verb, path, body, basePath, routeKey }) => {
        const base = new URL(basePath, location.origin);
        const target = new URL(path, base);
        if (target.origin !== location.origin || !target.pathname.startsWith(`${base.pathname}api/`)) {
            throw new Error('The RoboTeam API path left the RoboTeam route.');
        }
        const headers = { accept: 'application/json' };
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (!['GET', 'HEAD', 'OPTIONS'].includes(verb)) {
            const tokenUrl = new URL('/auth/token', location.origin);
            tokenUrl.searchParams.set('mutationRoute', routeKey);
            const proofResponse = await fetch(tokenUrl, { credentials: 'include', cache: 'no-store' });
            const proofPayload = await proofResponse.json().catch(() => ({}));
            const proof = proofPayload?.browserMutation;
            if (!proofResponse.ok || !proof?.csrfToken || proof.routeKey !== routeKey || (proof.origin && proof.origin !== location.origin)) {
                throw new Error(`Browser mutation proof for ${routeKey} is unavailable.`);
            }
            headers['x-ploinky-browser-csrf-token'] = proof.csrfToken;
        }
        const response = await fetch(target, { method: verb, credentials: 'include', headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const payload = await response.json().catch(() => ({}));
        return { status: response.status, payload };
    }, { verb, path, body, basePath: ROBOTEAM_BASE_PATH, routeKey: ROBOTEAM_ROUTE_KEY });
}

// Resolves the id of the one robot with this name. The page must be under the RoboTeam route.
export async function roboTeamRobotId(page, name = 'default') {
    const { status, payload } = await roboTeamApi(page, { path: 'api/robots' });
    assert.equal(status, 200, `GET api/robots returned HTTP ${status}: ${payload?.error || 'no error text'}`);
    const matches = (Array.isArray(payload?.robots) ? payload.robots : []).filter(robot => robot?.name === name);
    assert.equal(matches.length, 1, `Expected exactly one RoboTeam robot named ${name}, found ${matches.length}.`);
    assert.match(matches[0].id, ROBOT_ID, 'RoboTeam returned an invalid robot id.');
    return matches[0].id;
}

async function expectLoaded(skillsPage, { text = true } = {}) {
    await expect(skillsPage.locator(LIST)).toHaveAttribute('data-loaded', 'true');
    await expect(skillsPage.locator(STATUS)).not.toHaveClass(/(?:^|\s)error(?:\s|$)/);
    if (text) await expect(skillsPage.locator(STATUS)).toContainText(LOADED_TEXT);
}

// From the WebChat page: menu, "Conversation skills" link, then the page it opens in a new tab.
export async function openConversationSkills(copilotPage) {
    await copilotPage.locator('#settingsBtn').click();
    const link = copilotPage.locator('#sessionSettingsLink');
    await expect(link).toBeVisible();
    await expect(link).toHaveText('Conversation skills');
    const popup = copilotPage.context().waitForEvent('page');
    await link.click();
    const skillsPage = await popup;
    await skillsPage.waitForLoadState('domcontentloaded');
    await expectLoaded(skillsPage);
    return skillsPage;
}

// Reads the page's current selection from its DOM contract. Throws until a valid catalog has been applied.
export async function conversationSkillsState(skillsPage) {
    await expectLoaded(skillsPage, { text: false });
    const state = await skillsPage.locator(LIST).evaluate(list => ({
        robotId: list.getAttribute('data-robot-id'),
        sessionId: list.getAttribute('data-session-id'),
        policyVersion: list.getAttribute('data-policy-version'),
        items: [...list.querySelectorAll(':scope > li.conversation-skill-row')].map(row => ({
            identity: row.getAttribute('data-identity'),
            name: row.getAttribute('data-name'),
            state: row.getAttribute('data-state'),
            enabled: row.getAttribute('data-enabled') === 'true',
        })),
    }));
    assert.match(state.robotId || '', ROBOT_ID, 'The page does not name a valid robot.');
    assert.match(state.sessionId || '', UUID, 'The page does not name a valid conversation.');
    assert.match(state.policyVersion || '', /^\d+$/, 'The page does not show a policy version.');
    return { ...state, policyVersion: Number(state.policyVersion) };
}

function quoted(value) {
    return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// Toggles one skill of this conversation through the page and returns the resulting state. The row must
// currently hold the opposite value, the toggle's aria-pressed must flip and the policy version must increase.
export async function setConversationSkill(skillsPage, identity, enabled) {
    assert.equal(typeof enabled, 'boolean');
    const before = await conversationSkillsState(skillsPage);
    const current = before.items.filter(item => item.identity === identity);
    assert.equal(current.length, 1, `Expected exactly one skill row for ${identity}.`);
    assert.equal(current[0].enabled, !enabled, `${identity} is already ${enabled ? 'enabled' : 'disabled'}.`);
    const row = skillsPage.locator(`${ROWS}[data-identity=${quoted(identity)}]`);
    await expect(row).toHaveCount(1);
    const toggle = row.locator('button.conversation-skill-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', String(!enabled));
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', String(enabled));
    await expect.poll(async () => (await conversationSkillsState(skillsPage)).policyVersion).toBeGreaterThan(before.policyVersion);
    const after = await conversationSkillsState(skillsPage);
    assert.equal(after.robotId, before.robotId);
    assert.equal(after.sessionId, before.sessionId);
    assert.equal(after.items.filter(item => item.identity === identity && item.enabled === enabled).length, 1,
        `${identity} did not become ${enabled ? 'enabled' : 'disabled'}.`);
    return after;
}

// Reloads the selection through the page's Refresh button and waits for the answer to that request.
export async function refreshConversationSkills(skillsPage) {
    const refresh = skillsPage.locator('#conversationSkillsRefresh');
    await expect(refresh).toHaveAccessibleName('Refresh skills');
    const answered = skillsPage.waitForResponse(response => response.request().method() === 'GET'
        && /\/api\/robots\/[^/]+\/conversations\/[^/]+\/skills$/.test(new URL(response.url()).pathname));
    await refresh.click();
    assert.equal((await answered).status(), 200, 'Refreshing the conversation skills failed.');
    await expectLoaded(skillsPage);
    return conversationSkillsState(skillsPage);
}
