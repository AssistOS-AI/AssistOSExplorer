import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Internal application plugins are mounted inside <file-exp>. WebSkel renders a
// component only after its presenter calls invalidate(), and the component's
// renderCompletePromise settles only after that render. A presenter that never
// calls invalidate() is never rendered and leaves the promise pending, so
// anything that awaits it (for example waitForDescendantRenders or
// waitForPluginPresenterRender) would wait forever.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INTERNAL_SLOT = 'file-exp:internal';

function findInternalPlugins() {
    const plugins = [];
    for (const agent of fs.readdirSync(repoRoot, { withFileTypes: true })) {
        if (!agent.isDirectory()) continue;
        const pluginsDir = path.join(repoRoot, agent.name, 'IDE-plugins');
        if (!fs.existsSync(pluginsDir)) continue;
        for (const plugin of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
            if (!plugin.isDirectory()) continue;
            const configPath = path.join(pluginsDir, plugin.name, 'config.json');
            if (!fs.existsSync(configPath)) continue;
            let config;
            try {
                config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            } catch {
                // Discovery in explorer/utils/ide-plugins.mjs skips unparsable configs; such plugins are never mounted.
                continue;
            }
            const locations = Array.isArray(config.location) ? config.location : [config.location];
            if (!locations.includes(INTERNAL_SLOT)) continue;
            plugins.push({
                id: `${agent.name}/${plugin.name}`,
                modulePath: path.join(pluginsDir, plugin.name, `${config.component}.js`),
                presenter: config.presenter
            });
        }
    }
    return plugins;
}

test('internal file-exp plugins are discovered', () => {
    const ids = findInternalPlugins().map((plugin) => plugin.id);
    assert.ok(ids.includes('dpuAgent/dpu-runtime-support'), `internal plugins: ${ids.join(', ')}`);
});

test('every internal file-exp plugin presenter requests its first render from the constructor', async () => {
    for (const plugin of findInternalPlugins()) {
        const module = await import(pathToFileURL(plugin.modulePath).href);
        const Presenter = module[plugin.presenter];
        assert.equal(typeof Presenter, 'function', `${plugin.id} must export ${plugin.presenter}`);
        let invalidations = 0;
        new Presenter({}, () => { invalidations += 1; });
        assert.equal(invalidations, 1, `${plugin.id} must call invalidate() once in its constructor`);
    }
});
