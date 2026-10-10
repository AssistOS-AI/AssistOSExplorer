import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { authHeader, routerFetch as fetch } from './helpers/router-signed.mjs';

test('authenticated dashboard serves its tab markup and controller without starting robots', async t => {
    const server = createRoboTeamServer({
        robotStore: {}, runtimeManager: {}, robotModels: {}, skillsets: {},
        internalToken: 'dashboard-test', publicBasePath: '/rt/',
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { 'x-ploinky-auth-info': authHeader('actor', ['admin']) };
    const page = await fetch(`${base}/`, { headers });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="robotsTab"[\s\S]*id="workflowTypesTab"[\s\S]*id="kronJobsTab"/);
    const controller = await fetch(`${base}/dashboard-tabs.js`, { headers });
    assert.equal(controller.status, 200);
    assert.match(controller.headers.get('content-type'), /javascript/);
    assert.match(await controller.text(), /export function initDashboardTabs/);
    const controls = await fetch(`${base}/robot-controls.js`, { headers });
    assert.equal(controls.status, 200);
    assert.match(controls.headers.get('content-type'), /javascript/);
    assert.match(await controls.text(), /export function initCreateRobotDialog/);
    const navigation = await fetch(`${base}/page-navigation.js`, { headers });
    assert.equal(navigation.status, 200);
    assert.match(navigation.headers.get('content-type'), /javascript/);
    assert.match(await navigation.text(), /export function initPageNavigation/);
    const anonymousNavigation = await fetch(`${base}/page-navigation.js`);
    assert.equal(anonymousNavigation.status, 401);
    await anonymousNavigation.text();
    const anonymous = await fetch(`${base}/robot-controls.js`);
    assert.equal(anonymous.status, 401);
    await anonymous.text();
});
