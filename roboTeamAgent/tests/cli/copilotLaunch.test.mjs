import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildCopilotUrl,
    getCopilotLaunchExtensions
} from '../achilles-cli/IDE-plugins/achilles-cli-tool-button/copilot-launch.js';

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
                    'research-tags': '1',
                    'forward-envelope': '1',
                    'tag-relay-agent': 'researchRelay',
                    'tag-relay-submit-tool': 'research_task_submit',
                    'tag-relay-tags': 'open-interpreter,oi'
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
        assert.equal(params.get('research-tags'), '1');
        assert.equal(params.get('forward-envelope'), '1');
        assert.equal(params.get('tag-relay-agent'), 'researchRelay');
        assert.equal(params.get('tag-relay-submit-tool'), 'research_task_submit');
        assert.equal(params.get('tag-relay-tags'), 'open-interpreter,oi');
        assert.equal(params.get('workspace-dir'), 'docs');
        assert.equal(params.has('dir'), false);
    });

    it('falls back to dir when an extension asks for a relative directory outside the workspace', () => {
        setRuntimePlugins([{
            copilotLaunch: {
                query: { 'research-tags': '1' },
                workspaceDirParam: 'workspace-dir'
            }
        }]);
        const url = buildCopilotUrl({
            isDirectory: true,
            selectedFsPath: '/other/project',
            workspaceRoot: '/workspace/project'
        });
        const params = new URLSearchParams(url.slice('/webchat?'.length));
        assert.equal(params.get('research-tags'), '1');
        assert.equal(params.get('dir'), '/other/project');
        assert.equal(params.has('workspace-dir'), false);
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
