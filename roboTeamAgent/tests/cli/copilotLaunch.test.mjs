import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const copilotLaunchPath = path.join(
    __dirname,
    '../achilles-cli/IDE-plugins/achilles-cli-tool-button/copilot-launch.js'
);
const copilotLaunchSource = fs.readFileSync(copilotLaunchPath, 'utf8');
const {
    buildCopilotUrl,
    getCopilotLaunchExtensions,
} = await import(`data:text/javascript,${encodeURIComponent(copilotLaunchSource)}`);

const originalWindow = globalThis.window;

afterEach(() => {
    globalThis.window = originalWindow;
});

function setRuntimePlugins(entries) {
    globalThis.window = {
        assistOS: {
            runtimePlugins: {
                application: {
                    'file-exp:copilot-launch-extension': entries
                }
            }
        }
    };
}

describe('Copilot launch extensions', () => {
    it('keeps the default Copilot launch URL when no extension is enabled', () => {
        setRuntimePlugins([]);
        const url = buildCopilotUrl({
            isDirectory: true,
            selectedFsPath: '/workspace/project'
        });
        assert.equal(url, '/webchat?agent=achilles-cli&dir=%2Fworkspace%2Fproject');
    });

    it('adds generic launch-extension query parameters and workspace-relative directory', () => {
        setRuntimePlugins([{
            copilotLaunch: {
                query: {
                    'forward-envelope': '1'
                },
                workspaceDirParam: 'workspace-dir'
            }
        }]);

        const url = buildCopilotUrl({
            isDirectory: true,
            selectedFsPath: '/workspace/project/docs',
            workspaceRoot: '/workspace/project'
        });
        const params = new URLSearchParams(url.slice('/webchat?'.length));
        assert.equal(params.get('agent'), 'achilles-cli');
        assert.equal(params.get('forward-envelope'), '1');
        assert.equal(params.has('research-tags'), false);
        assert.equal(params.has('tag-relay-agent'), false);
        assert.equal(params.has('tag-relay-submit-tool'), false);
        assert.equal(params.has('tag-relay-tags'), false);
        assert.equal(params.get('workspace-dir'), 'docs');
        assert.equal(params.has('dir'), false);
    });

    it('falls back to dir when an extension asks for a relative directory outside the workspace', () => {
        setRuntimePlugins([{
            copilotLaunch: {
                query: { 'forward-envelope': '1' },
                workspaceDirParam: 'workspace-dir'
            }
        }]);
        const url = buildCopilotUrl({
            isDirectory: true,
            selectedFsPath: '/other/project',
            workspaceRoot: '/workspace/project'
        });
        const params = new URLSearchParams(url.slice('/webchat?'.length));
        assert.equal(params.get('forward-envelope'), '1');
        assert.equal(params.get('dir'), '/other/project');
        assert.equal(params.has('workspace-dir'), false);
    });

    it('opens the workspace root from the Explorer Tools plugin context', () => {
        setRuntimePlugins([{
            copilotLaunch: {
                query: { 'forward-envelope': '1' },
                workspaceDirParam: 'workspace-dir'
            }
        }]);
        const url = buildCopilotUrl({
            currentPath: '/',
            currentFsPath: '/workspace/project',
            workspaceFsRoot: '/workspace/project'
        });
        const params = new URLSearchParams(url.slice('/webchat?'.length));
        assert.equal(params.get('agent'), 'achilles-cli');
        assert.equal(params.get('workspace-dir'), '.');
        assert.equal(params.has('dir'), false);
    });

    it('opens the current Explorer folder from the Tools plugin context', () => {
        setRuntimePlugins([{
            copilotLaunch: {
                workspaceDirParam: 'workspace-dir'
            }
        }]);
        const url = buildCopilotUrl({
            currentPath: '/ploinky',
            currentFsPath: '/workspace/project/ploinky',
            workspaceFsRoot: '/workspace/project'
        });
        const params = new URLSearchParams(url.slice('/webchat?'.length));
        assert.equal(params.get('workspace-dir'), 'ploinky');
        assert.equal(params.has('dir'), false);
    });

    it('discovers only runtime plugins that declare a copilotLaunch object', () => {
        setRuntimePlugins([
            { copilotLaunch: { query: { enabled: '1' } } },
            { copilotLaunch: null },
            { otherConfig: true }
        ]);
        assert.equal(getCopilotLaunchExtensions().length, 1);
    });
});
