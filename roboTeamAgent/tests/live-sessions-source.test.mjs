import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PUBLIC_BASE_PATH } from '../server/constants.mjs';
import { SOURCE_BASE } from './helpers/live-sessions-scenario.mjs';

// RoboTeam's Live Sessions source declaration, discovered and normalized by
// Explorer's real server discovery and browser normalization, imported
// from the owning Explorer checkout.
const AGENT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CONFIG = path.join(AGENT_ROOT, 'IDE-plugins', 'live-sessions-source', 'config.json');
const EXPLORER = new URL('../../explorer/utils/', import.meta.url);
const { aggregateIdePlugins } = await import(new URL('ide-plugins.mjs', EXPLORER).href);
const { normalizeRuntimePlugins } = await import(new URL('pluginUtils.core.js', EXPLORER).href);
const DECLARATION = { pluginCategory: 'application', id: 'roboteam-live-sessions', label: 'RoboTeam', contributionType: 'live-sessions-source',
    location: ['live-sessions:source'], liveSessions: { version: 1, base: '/base-agent-additional-server/roboTeamAgent/3001/api/live-sessions' } };

test('the source declaration is exactly the Explorer contract under the RoboTeam service route', async () => {
    const config = JSON.parse(await fs.readFile(CONFIG, 'utf8'));
    assert.deepEqual(config, DECLARATION);
    // The base is the RoboTeam service's public route and its Live Sessions API.
    const manifest = JSON.parse(await fs.readFile(path.join(AGENT_ROOT, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.routerAccess.httpRoutes, [{ path: '/base-agent-additional-server/roboTeamAgent/3001/*', access: 'authenticated' }]);
    assert.equal(config.liveSessions.base, `${PUBLIC_BASE_PATH}api/live-sessions`);
    assert.equal(config.liveSessions.base, SOURCE_BASE, 'the conformance tests replay this exact base');
});

async function workspaceWith(t, agentDirectoryName, routedAgent) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ls-source-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const agentDir = path.join(root, 'AchillesIDE', agentDirectoryName);
    await fs.mkdir(path.join(agentDir, 'IDE-plugins', 'live-sessions-source'), { recursive: true });
    await fs.copyFile(CONFIG, path.join(agentDir, 'IDE-plugins', 'live-sessions-source', 'config.json'));
    await fs.copyFile(path.join(AGENT_ROOT, 'manifest.json'), path.join(agentDir, 'manifest.json'));
    if (routedAgent) {
        await fs.mkdir(path.join(root, '.ploinky'));
        await fs.writeFile(path.join(root, '.ploinky', 'routing.json'),
            JSON.stringify({ routes: { [routedAgent]: { repo: 'AchillesIDE', agent: routedAgent, hostPath: agentDir } } }));
    }
    return root;
}

test('Explorer discovery assigns the routed agent and keeps the source', async (t) => {
    const discovered = await aggregateIdePlugins(await workspaceWith(t, 'roboTeamAgent', 'roboTeamAgent'));
    const sources = discovered.application['live-sessions:source'];
    assert.equal(sources.length, 1);
    assert.equal(sources[0].agent, 'roboTeamAgent');
    assert.deepEqual(sources[0].liveSessions, DECLARATION.liveSessions);
    const browser = normalizeRuntimePlugins({ application: { 'live-sessions:source': sources } });
    assert.deepEqual(browser.application['live-sessions:source'].map(({ agent, id, label, liveSessions }) => ({ agent, id, label, liveSessions })),
        [{ agent: 'roboTeamAgent', id: 'roboteam-live-sessions', label: 'RoboTeam', liveSessions: DECLARATION.liveSessions }]);
});

test('under any other agent name the base is not owned and Explorer drops the source', async (t) => {
    for (const name of ['roboteamagent', 'RoboTeam']) {
        const discovered = await aggregateIdePlugins(await workspaceWith(t, name, name));
        assert.equal(discovered.application['live-sessions:source']?.length ?? 0, 0, name);
    }
});
