import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('workspace orchestration tools are internal while administrator mutations stay authenticated', async () => {
    const config = JSON.parse(await fs.readFile(path.join(AGENT_ROOT, 'mcp-config.json'), 'utf8'));
    const tools = new Map(config.tools.map((tool) => [tool.name, tool]));
    for (const name of [
        'robot_list',
        'startDesktopTaskForRobot',
        'stopDesktopTaskForRobot',
        'startBrowserTaskForRobot',
        'stopBrowserTaskForRobot',
        'startSimpleALATaskForRobot',
        'stopSimpleALATaskForRobot',
        'getTaskStatusForRobot',
        'getSessionUrlForRobotDesktop',
        'getSessionUrlForRobotBrowser',
        'stopDesktopContainerForRobot',
        'stopBrowserContainerForRobot',
    ]) {
        assert.deepEqual(tools.get(name)?.tags, ['internal'], `${name} must be internal`);
    }
    for (const name of ['robot_create', 'robot_delete']) {
        assert.deepEqual(tools.get(name)?.tags, ['admin'], `${name} must require administrator access`);
        assert.match(tools.get(name)?.description || '', /administrator role/i);
    }
});
