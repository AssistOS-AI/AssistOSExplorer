import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readAgentJson(fileName) {
    const raw = await fs.readFile(path.join(AGENT_ROOT, fileName), 'utf8');
    return JSON.parse(raw);
}

test('webAssist manifest keeps the embedded chat reachable as a guest surface', async () => {
    const manifest = await readAgentJson('manifest.json');

    assert.equal(manifest.guest, true, 'manifest-level guest auth must remain enabled');
    assert.equal(manifest.volumes?.['webassist-data'], undefined);
    assert.deepEqual(manifest.runtime?.resources?.persistentStorage, {
        key: 'webAssist',
        containerPath: '/workspace/webassist-data'
    });
    assert.equal(manifest.runtime?.resources?.env?.WEBASSIST_DATA_ROOT, '{{STORAGE_CONTAINER_PATH}}/data');
    assert.equal(manifest.volumes?.['.data/webAssist/debuglogs'], '/code/debuglogs');
    assert.equal(
        path.posix.join('.data', manifest.runtime.resources.persistentStorage.key, 'data'),
        '.data/webAssist/data',
        'host-sandbox translation must match the UI workspace-dir value'
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(manifest, 'httpServices'),
        false,
        'webAssist must not expose guest chat through legacy httpServices'
    );

    const routes = manifest.routerAccess?.httpRoutes;
    assert.ok(Array.isArray(routes), 'manifest must declare routerAccess.httpRoutes');

    const embeddedChatRoute = routes.find((route) => route?.path === '/IDE-plugins/web-assist-chat/*');
    assert.deepEqual(
        embeddedChatRoute,
        { path: '/IDE-plugins/web-assist-chat/*', access: 'guest' },
        'embedded chat assets must be explicitly guest-routed'
    );

    for (const route of routes) {
        assert.notEqual(route?.access, 'public', `${route?.path || '<unknown>'} must not bypass guest auth`);
    }
});

// Every tool stays listed and router-callable for guest sessions (no admin tag).
// `list-sites` is still restricted: its handler denies callers without admin or
// `explorer.access` (see session-ownership.mcp.test.mjs).
test('webAssist MCP tools remain listed for guest-authenticated sessions with handler-enforced authorization', async () => {
    const config = await readAgentJson('mcp-config.json');
    const tools = Array.isArray(config.tools) ? config.tools : [];
    assert.ok(tools.length > 0, 'mcp-config.json must declare tools');

    const requiredTools = new Set(['web_cli_chat', 'web_cli_history', 'register-events', 'list-sites']);
    const toolNames = new Set(tools.map((tool) => tool?.name).filter(Boolean));
    for (const toolName of requiredTools) {
        assert.ok(toolNames.has(toolName), `${toolName} must remain listed; list-sites authorization is enforced by its handler`);
    }

    for (const tool of tools) {
        const tags = Array.isArray(tool?.tags) ? tool.tags.map((tag) => String(tag).toLowerCase()) : [];
        assert.equal(tags.includes('admin'), false, `${tool.name} must not require admin access`);
        assert.equal(tags.includes('internal'), false, `${tool.name} must not require internal-only access`);
        assert.equal(tags.includes('mcp-admin'), false, `${tool.name} must not require MCP admin access`);
    }
});
