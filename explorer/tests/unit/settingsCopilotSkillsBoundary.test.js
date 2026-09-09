import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const explorerRoot = path.resolve(import.meta.dirname, '../..');

test('Copilot settings consume the default RoboTeam robot public skill catalog', async () => {
    const controller = await fs.readFile(
        path.join(explorerRoot, 'web-components/modals/settings-modal/settings-copilot-controller.js'),
        'utf8'
    );
    const handlers = await fs.readFile(path.join(explorerRoot, 'utils/server/tool-handlers.mjs'), 'utf8');
    const styles = await fs.readFile(
        path.join(explorerRoot, 'web-components/modals/settings-modal/settings-modal.css'),
        'utf8'
    );
    const mcpConfig = JSON.parse(await fs.readFile(path.join(explorerRoot, 'mcp-config.json'), 'utf8'));

    assert.match(controller, /callAgentTool\("roboTeamAgent", "list_achilles_skills", \{ robot: "default" \}/);
    assert.doesNotMatch(controller, /callExplorerTool\("list-skills"/);
    assert.doesNotMatch(handlers, /discoverSkills|achillesAgentLib|AchillesCLI.*node_modules/);
    assert.equal(mcpConfig.tools.some((tool) => tool.name === 'list-skills'), false);
    assert.match(controller, /copilotStatusType = "loading"/);
    assert.match(controller, /plugin-settings-inline-spinner/);
    assert.match(styles, /\.plugin-settings-inline-spinner/);
});
