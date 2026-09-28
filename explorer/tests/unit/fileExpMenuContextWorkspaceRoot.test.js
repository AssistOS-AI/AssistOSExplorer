import test from 'node:test';
import assert from 'node:assert/strict';

test('menu contribution contexts carry the workspace filesystem root', async () => {
    const previousWindow = globalThis.window;
    globalThis.window = {
        ASSISTOS_FS_ROOT: '/workspace/root',
        assistOS: {},
        addEventListener() {},
        removeEventListener() {}
    };
    try {
        const { FILE_EXP_MENU_SLOTS, buildFileExpMenuContext } = await import(
            '../../web-components/pages/file-exp/file-exp-menu-contributions.js'
        );
        const fileExp = {
            state: { path: '/docs', selectedPath: '' },
            normalizePath(value) { return String(value || ''); }
        };

        const directory = await buildFileExpMenuContext(fileExp, FILE_EXP_MENU_SLOTS.contextDirectory, {
            path: '/docs/project', type: 'directory', name: 'project'
        });
        assert.equal(directory.workspaceFsRoot, '/workspace/root');
        assert.equal(directory.selectedFsPath, '/workspace/root/docs/project');
        assert.equal(directory.isDirectory, true);

        const newMenu = await buildFileExpMenuContext(fileExp, FILE_EXP_MENU_SLOTS.newMenu);
        assert.equal(newMenu.workspaceFsRoot, '/workspace/root');
        assert.equal(newMenu.currentFsPath, '/workspace/root/docs');
    } finally {
        globalThis.window = previousWindow;
    }
});
