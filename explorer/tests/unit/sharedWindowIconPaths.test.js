import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { siblingRoot } from '../../../tests/helpers/sibling-roots.mjs';

const explorerRoot = new URL('../../', import.meta.url);
const repoRoot = new URL('../', explorerRoot);

// Agents of this repository, and agents that moved to a sibling checkout (a
// missing sibling throws).
const siblingAgentsUrl = (repo) => pathToFileURL(`${siblingRoot(repo)}/`);
const uiRoots = [
    ['explorer', repoRoot], ['gitAgent', repoRoot], ['dpuAgent', repoRoot], ['emailAgent', repoRoot],
    ['tasksAgent', siblingAgentsUrl('legacy-agents')], ['webAssist', siblingAgentsUrl('legacy-agents')],
    ['soplangAgent', siblingAgentsUrl('legacy-agents')], ['multimedia', siblingAgentsUrl('legacy-agents')],
    ['webmeetAgent', siblingAgentsUrl('webmeet')],
];

async function* uiSources(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (['node_modules', 'vendor', 'tests', 'docs', 'assets', 'skills'].includes(entry.name)) {
            continue;
        }
        const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
        if (entry.isDirectory()) {
            yield* uiSources(url);
        } else if (/\.(html|js|mjs|css)$/.test(entry.name)) {
            yield url;
        }
    }
}

async function assertSharedWindowIcons(templateUrl) {
    const html = await fs.readFile(templateUrl, 'utf8');
    const icons = [...html.matchAll(/src="(\/explorer\/(?:shared\/)?assets\/icons\/(?:fullscreen|x-mark)\.svg)"/g)];
    assert.ok(icons.length > 0, `Window icons must remain present in ${templateUrl.pathname}`);
    for (const [, src] of icons) {
        assert.ok(src.startsWith('/explorer/shared/assets/icons/'), `Use the existing shared icon: ${src}`);
        const icon = await fs.readFile(new URL(src.slice('/explorer/'.length), explorerRoot), 'utf8');
        assert.match(icon, /<svg\b/);
    }
}

test('DPU Data Sources uses existing shared fullscreen and close icons', async () => {
    await assertSharedWindowIcons(new URL('dpuAgent/IDE-plugins/dpu-runtime-support/dpu-data-sources-settings/dpu-data-sources-settings.html', repoRoot));
});

test('Git dialog close icons resolve to existing shared assets', async () => {
    const base = new URL('gitAgent/IDE-plugins/git-tool-button/components/', repoRoot);
    for (const name of [
        'git-branch-create-modal', 'git-branch-dirty-modal', 'git-commit-message-fallback-modal',
        'git-stash-select-modal', 'git-add-repository-modal', 'git-branch-select-modal', 'git-clone-repository-modal'
    ]) {
        await assertSharedWindowIcons(new URL(`${name}/${name}.html`, base));
    }
});

for (const [root, base] of uiRoots) {
    test(`${root} modal and UI icon paths are explicit and resolve to existing SVGs`, async () => {
        let checked = 0;
        for await (const url of uiSources(new URL(`${root}/`, base))) {
            const source = (await fs.readFile(url, 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
            const icons = source.matchAll(/(?:\.\/|\/explorer\/(?:shared\/)?)assets\/icons\/[\w/-]+\.svg/g);
            for (const [src] of icons) {
                assert.ok(src.startsWith('/explorer/'), `Page-relative icon in ${url.pathname}: ${src}`);
                const icon = await fs.readFile(new URL(src.slice('/explorer/'.length), explorerRoot), 'utf8');
                assert.match(icon, /<svg\b/, `Invalid icon in ${url.pathname}: ${src}`);
                for (const page of ['http://localhost/', 'http://localhost/explorer/', 'http://localhost/nested/page']) {
                    assert.equal(new URL(src, page).pathname, src);
                }
                checked++;
            }
        }
        assert.ok(checked > 0, `No UI icons checked for ${root}`);
    });
}

test('dynamic document status icons use a page-independent Explorer path', async () => {
    const source = await fs.readFile(new URL('web-components/components/document-view-page/UIUtils.js', explorerRoot), 'utf8');
    assert.doesNotMatch(source, /\.\/assets\/icons\//);
    assert.ok(source.includes('/explorer/assets/icons/${status}.svg'));
    assert.ok(source.includes('/explorer/assets/icons/${errorStatus}.svg'));
});

test('SOPLang variable modal icons resolve relative to their module, not the open page', async () => {
    const base = new URL('soplangAgent/IDE-plugins/edit-variables/', siblingAgentsUrl('legacy-agents'));
    const moduleUrl = new URL('components/edit-variable-tab/varUtilsUI.js', base);
    const source = await fs.readFile(moduleUrl, 'utf8');
    const iconBase = source.match(/ICON_BASE_URL = new URL\("([^"]+)", import\.meta\.url\)/);
    assert.ok(iconBase, 'Keep the module-relative icon resolver');
    assert.match(source, /image\.src = new URL\(`\$\{iconName\}\.svg`, ICON_BASE_URL\)\.href/);
    let checked = 0;
    for await (const url of uiSources(new URL('components/', base))) {
        const template = await fs.readFile(url, 'utf8');
        for (const [, name] of template.matchAll(/data-edit-variable-icon="([\w-]+)"/g)) {
            const icon = await fs.readFile(new URL(`${name}.svg`, new URL(iconBase[1], moduleUrl)), 'utf8');
            assert.match(icon, /<svg\b/);
            checked++;
        }
    }
    assert.ok(checked > 0);
});
