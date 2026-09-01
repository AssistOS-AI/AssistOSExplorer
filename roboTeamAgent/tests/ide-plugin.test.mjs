import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RoboTeamToolButton } from '../IDE-plugins/roboteam-tool-button/roboteam-tool-button.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const pluginDirectory = join(testDirectory, '..', 'IDE-plugins', 'roboteam-tool-button');

test('declares an Explorer toolbar plugin immediately after WebMeet', async () => {
    const config = JSON.parse(await readFile(join(pluginDirectory, 'config.json'), 'utf8'));
    assert.equal(config.pluginCategory, 'application');
    assert.equal(config.id, 'roboteam');
    assert.equal(config.component, 'roboteam-tool-button');
    assert.deepEqual(config.location, ['file-exp:toolbar']);
    assert.equal(config.locationOrder, 350);
    assert.equal(config.presenter, 'RoboTeamToolButton');

    const [icon, html, css, source] = await Promise.all([
        'icon.svg',
        'roboteam-tool-button.html',
        'roboteam-tool-button.css',
        'roboteam-tool-button.js',
    ].map((name) => readFile(join(pluginDirectory, name), 'utf8')));
    assert.match(icon, /^<svg/);
    assert.match(html, /app-plugin-tool-button/);
    assert.match(html, /app-plugin-tool-icon/);
    assert.match(html, /app-plugin-tool-label/);
    assert.match(css, /data-host-orientation="horizontal"/);
    assert.doesNotMatch(source, /ROBOTEAM_INTERNAL_TOKEN|PLOINKY_MASTER_KEY|authorization|\/mcp/i);
});

test('opens the authenticated RoboTeam dashboard and follows host metadata', () => {
    const listeners = new Map();
    const button = {
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        removeEventListener(type, listener) {
            if (listeners.get(type) === listener) listeners.delete(type);
        },
        setAttribute(name, value) {
            this[name] = value;
        },
    };
    const icon = {};
    const label = {};
    const element = {
        getAttribute() {
            return '';
        },
        querySelector(selector) {
            return {
                '#roboteamToolButton': button,
                '.roboteam-tool-button-icon-image': icon,
                '.roboteam-tool-button-label': label,
            }[selector];
        },
    };
    const calls = [];
    const previousWindow = globalThis.window;
    globalThis.window = {
        open(...args) {
            calls.push(args);
        },
    };

    try {
        const presenter = new RoboTeamToolButton(element, () => {});
        presenter.updateHostContext({
            pluginLabel: 'Robot team',
            pluginTooltip: 'Open profiles',
            pluginIcon: '/workspace-files/roboteam/icon.svg',
        });
        presenter.afterRender();
        listeners.get('click')({ preventDefault() {}, stopPropagation() {} });

        assert.equal(label.textContent, 'Robot team');
        assert.equal(button.title, 'Open profiles');
        assert.equal(button['aria-label'], 'Open profiles');
        assert.equal(icon.src, '/workspace-files/roboteam/icon.svg');
        assert.deepEqual(calls, [[
            '/base-agent-additional-server/roboTeamAgent/3001/',
            '_blank',
            'noopener,noreferrer',
        ]]);

        presenter.afterUnload();
        assert.equal(listeners.has('click'), false);
    } finally {
        globalThis.window = previousWindow;
    }
});

test('opens a pending robot session before awaiting startup and toggles the active mode to stop', async () => {
    const source = await readFile(join(testDirectory, '..', 'public', 'app.js'), 'utf8');
    const html = await readFile(join(testDirectory, '..', 'public', 'index.html'), 'utf8');
    const startFunction = source.slice(source.indexOf('async function startRobot'), source.indexOf('function renderRobots'));
    assert.ok(startFunction.indexOf('openPendingSession(robot, mode)') < startFunction.indexOf('await api('));
    assert.match(source, /robot\.run\.state === 'running' && robot\.run\.sessionUrl/);
    assert.match(source, /browserRunning \? 'Stop Browser' : 'Start Browser'/);
    assert.match(source, /desktopRunning \? 'Stop Desktop' : 'Start Desktop'/);
    assert.match(source, /stopRobot\(robot, event\.currentTarget\)/);
    assert.match(source, /window\.location\.assign\(url\)/);
    assert.doesNotMatch(html, /stop-robot/);
});
