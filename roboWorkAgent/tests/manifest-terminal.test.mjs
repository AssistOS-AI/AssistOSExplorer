import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = async file => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
const PREFIX = '/base-agent-additional-server/roboWorkAgent/3001';

test('the manifest and the Explorer plugin declare the same terminal profile surface behind an authenticated route', async () => {
    const manifest = await read('../manifest.json');
    const plugin = await read('../IDE-plugins/terminal-profile-source/config.json');
    const { resolve } = manifest.webtty.homeProfiles;
    assert.equal(manifest.webtty.homeProfiles.version, 1);
    assert.equal(plugin.terminalProfiles.version, 1);
    assert.match(resolve, /\/api\/terminal-profiles\/resolve$/u);
    assert.equal(resolve.slice(0, -'/resolve'.length), plugin.terminalProfiles.base);
    assert.ok(plugin.terminalProfiles.base.startsWith(`${PREFIX}/`));
    assert.equal(plugin.terminalProfiles.environments, true);
    assert.deepEqual([plugin.pluginCategory, plugin.contributionType, plugin.location], ['application', 'terminal-profile-source', ['terminal-profiles:source']]);
    // The router admits the profile calls through the agent's authenticated route and no other.
    assert.deepEqual(manifest.routerAccess.httpRoutes, [{ path: `${PREFIX}/*`, access: 'authenticated' }]);
    assert.ok(plugin.terminalProfiles.base.startsWith(manifest.routerAccess.httpRoutes[0].path.slice(0, -1)));
    // The route's container port is the one the manifest publishes.
    assert.ok(manifest.profiles.default.openPorts.some(entry => entry.endsWith(':3001')));
});
