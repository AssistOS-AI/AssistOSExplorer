import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const copilotLaunchPath = path.join(
    __dirname,
    '../roboTeamAgent/IDE-plugins/achilles-cli-tool-button/copilot-launch.js'
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
            selectedFsPath: '/workspace/project',
            workspaceRoot: '/workspace/project'
        });
        assert.equal(url, '/webchat?agent=roboTeamAgent&robot=default&workspace-dir=.');
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
        assert.equal(params.get('agent'), 'roboTeamAgent');
        assert.equal(params.get('robot'), 'default');
        assert.equal(params.get('forward-envelope'), '1');
        assert.equal(params.has('research-tags'), false);
        assert.equal(params.has('tag-relay-agent'), false);
        assert.equal(params.has('tag-relay-submit-tool'), false);
        assert.equal(params.has('tag-relay-tags'), false);
        assert.equal(params.get('workspace-dir'), 'docs');
        assert.equal(params.has('dir'), false);
    });

    it('rejects a directory outside the workspace instead of launching at the root', () => {
        setRuntimePlugins([]);
        assert.throws(() => buildCopilotUrl({
            isDirectory: true,
            selectedFsPath: '/other/project',
            workspaceRoot: '/workspace/project'
        }), /valid workspace directory/);
    });

    it('uses the selected Explorer path even when filesystem-root discovery is unavailable', () => {
        setRuntimePlugins([]);
        const url = new URL(buildCopilotUrl({
            isDirectory: true,
            selectedPath: '/projects/My folder & notes',
            selectedFsPath: '/projects/My folder & notes',
            workspaceFsRoot: '/'
        }), 'http://localhost');
        assert.equal(url.searchParams.get('workspace-dir'), 'projects/My folder & notes');
        assert.throws(() => buildCopilotUrl({ isDirectory: true, selectedPath: '/../outside' }), /valid workspace directory/);
        assert.throws(() => buildCopilotUrl({}), /valid workspace directory/);
    });

    it('opens the workspace root from an explicit Explorer root context', () => {
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
        assert.equal(params.get('agent'), 'roboTeamAgent');
        assert.equal(params.get('robot'), 'default');
        assert.equal(params.get('workspace-dir'), '.');
        assert.equal(params.has('dir'), false);
    });

    it('opens the current Explorer folder from an explicit Explorer directory context', () => {
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
