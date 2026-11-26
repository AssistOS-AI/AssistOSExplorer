import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    attachApplicationPluginHost,
    buildPluginContext,
    getApplicationPluginsForSlot,
    getToolbarPluginLayout,
    waitForPluginPresenterRender
} from '../../web-components/pages/file-exp/file-exp-application-plugins.js';

describe('application plugin host context', () => {
    it('includes Explorer and filesystem paths for the current directory', () => {
        const fileExp = {
            state: {
                path: '/ploinky',
                selectedPath: '/ploinky/package.json',
                workspaceVersion: 7
            },
            normalizePath(value) {
                return String(value || '').replace(/\/+$/g, '') || '/';
            }
        };

        const context = buildPluginContext(fileExp, 'file-exp:toolbar-plugins-dropdown', {
            currentFsPath: '/workspace/ploinky',
            workspaceFsRoot: '/workspace'
        });

        assert.deepEqual(context, {
            slot: 'file-exp:toolbar-plugins-dropdown',
            currentPath: '/ploinky',
            currentFsPath: '/workspace/ploinky',
            workspaceFsRoot: '/workspace',
            selectedPath: '/ploinky/package.json',
            workspaceVersion: 7
        });
    });

    it('does not expose admin-only application plugins to ordinary users', () => {
        globalThis.window = {
            assistOS: {
                user: { id: 'local:user', roles: ['user'] },
                workspace: {
                    appPlugins: {
                        'file-exp:account-menu': [
                            { id: 'workspace-monitor', adminOnly: true },
                            { id: 'help' }
                        ]
                    }
                },
                pluginSettings: {}
            }
        };
        const plugins = getApplicationPluginsForSlot('file-exp:account-menu');
        assert.deepEqual(plugins.map((plugin) => plugin.id), ['help']);
        delete globalThis.window;
    });

    it('exposes admin-only application plugins to administrators', () => {
        globalThis.window = {
            assistOS: {
                user: { id: 'local:admin', roles: ['admin'] },
                workspace: {
                    appPlugins: {
                        'file-exp:account-menu': [{ id: 'workspace-monitor', adminOnly: true }]
                    }
                },
                pluginSettings: {}
            }
        };
        const plugins = getApplicationPluginsForSlot('file-exp:account-menu');
        assert.deepEqual(plugins.map((plugin) => plugin.id), ['workspace-monitor']);
        delete globalThis.window;
    });

    it('waits for the active WebSkel render created after presenter readiness', async () => {
        let resolvePresenter;
        let resolveActiveRender;
        let completed = false;
        const pluginElement = {
            presenterReadyPromise: new Promise((resolve) => { resolvePresenter = resolve; }),
            renderCompletePromise: Promise.resolve()
        };
        const activeRender = new Promise((resolve) => { resolveActiveRender = resolve; });
        const waiting = waitForPluginPresenterRender(pluginElement).then(() => { completed = true; });

        resolvePresenter();
        queueMicrotask(() => { pluginElement.renderCompletePromise = activeRender; });
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(completed, false);

        resolveActiveRender();
        await waiting;
        assert.equal(completed, true);
    });

    it('refreshes discovered menu metadata without closing the active menu or rebuilding it at mount readiness', async () => {
        const listeners = new Map();
        let closeCalls = 0;
        let entryRenderCalls = 0;
        let toolbarRefreshCalls = 0;
        globalThis.window = {
            assistOS: {
                workspace: { appPlugins: {} },
                pluginSettings: {}
            }
        };
        const fileExp = {
            element: null,
            toolbarMenuItems: [{ id: 'stale' }],
            setWindowListener(key, eventName, handler) {
                listeners.set(eventName, handler);
            },
            closeActionMenu() {
                closeCalls += 1;
            },
            renderEntries() {
                entryRenderCalls += 1;
            },
            refreshToolbarMenuItems() {
                toolbarRefreshCalls += 1;
            }
        };

        attachApplicationPluginHost(fileExp);
        const runtimePluginsUpdated = listeners.get('assistos:runtime-plugins-updated');
        assert.equal(typeof runtimePluginsUpdated, 'function');

        runtimePluginsUpdated({ detail: { phase: 'discovered' } });
        assert.deepEqual(fileExp.toolbarMenuItems, []);
        assert.equal(closeCalls, 0);
        assert.equal(entryRenderCalls, 1);
        assert.equal(toolbarRefreshCalls, 1);

        runtimePluginsUpdated({ detail: { phase: 'ready' } });
        await Promise.resolve();
        assert.equal(closeCalls, 0);
        assert.equal(entryRenderCalls, 1);
        assert.equal(toolbarRefreshCalls, 1);
        delete globalThis.window;
    });
});


describe('toolbar plugin placement', () => {
    const primary = [
        { agent: 'webmeetAgent', id: 'webmeet', locationOrder: 300 },
        { agent: 'bizanso', id: 'bizanso', locationOrder: 370 },
        { agent: 'scriptahubAgent', id: 'scriptahub', locationOrder: 375 },
        { agent: 'explorer', id: 'live-sessions', locationOrder: 380, mountOnStart: true },
        { agent: 'explorer', id: 'help', locationOrder: 400 },
    ];
    const git = { agent: 'gitAgent', id: 'git', locationOrder: 100 };
    const extra = { agent: 'custom', id: 'tool', locationOrder: 200 };

    it('keeps WebMeet, Bizanso, ScriptaHub, Live Sessions and Help in the toolbar and sorts Tools without duplicates', () => {
        const layout = getToolbarPluginLayout([git, ...primary, extra], [extra, primary[0]], false);
        assert.deepEqual(layout.visibleToolbarPlugins, primary);
        assert.deepEqual(layout.visibleToolbarDropdownPlugins, [git, extra]);
    });

    it('keeps Live Sessions in the toolbar even when also declared in Tools', () => {
        const layout = getToolbarPluginLayout([git, ...primary], [git, extra, primary[3]], false);
        assert.deepEqual(layout.visibleToolbarPlugins, primary);
        assert.deepEqual(layout.visibleToolbarDropdownPlugins, [git, extra]);
    });
});
