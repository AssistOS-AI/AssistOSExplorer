import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ResourceManager, WebSkel } from '../../shared/libs/webskel/webskel.mjs';

test('runtime component registry cache-busts presenter module imports', async () => {
    const source = await fs.readFile(
        path.resolve(import.meta.dirname, '../../services/runtime/componentRegistry.js'),
        'utf8'
    );

    assert.match(source, /runtimeImportCacheBust = Date\.now\(\)\.toString\(36\)/);
    assert.match(source, /const importSequence = \+\+runtimeImportSequence/);
    assert.match(source, /const importVersion = `\$\{runtimeImportCacheBust\}-\$\{importSequence\}-\$\{attempt\}`/);
    assert.match(source, /const moduleUrl = `\$\{safeBase\}\.js\?runtimeImport=\$\{encodeURIComponent\(importVersion\)\}`/);
    assert.match(source, /import\(\/\* webpackIgnore: true \*\/ moduleUrl\)/);
});

test('WebSkel consumes preloaded component assets and presenters without fetching them', async (t) => {
    const instanceDescriptor = Object.getOwnPropertyDescriptor(WebSkel, 'instance');
    WebSkel.instance = { configs: { rootDir: '/explorer/web-components' } };
    t.after(() => {
        if (instanceDescriptor) Object.defineProperty(WebSkel, 'instance', instanceDescriptor);
        else delete WebSkel.instance;
    });
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
        assert.fail('Preloaded component assets must not be fetched again.');
    });
    const manager = new ResourceManager();
    const stylesheetCalls = [];
    t.mock.method(manager, 'loadStyleSheets', async (stylesheets, name) => {
        stylesheetCalls.push({ stylesheets, name });
    });
    class RuntimePresenter {}
    const component = {
        name: 'runtime-widget',
        type: 'components',
        loadedTemplate: '<section>Preloaded widget</section>',
        loadedCSSs: ['section { display: block; }'],
        presenterClassName: 'RuntimePresenter',
        presenterModule: { RuntimePresenter },
    };

    const loaded = await manager.loadComponent(component);
    const cached = await manager.loadComponent(component);

    assert.deepEqual(loaded, { html: component.loadedTemplate, css: component.loadedCSSs });
    assert.deepEqual(cached, loaded);
    assert.equal(manager.components[component.name].presenter, RuntimePresenter);
    assert.deepEqual(stylesheetCalls, [
        { stylesheets: component.loadedCSSs, name: component.name },
        { stylesheets: component.loadedCSSs, name: component.name },
    ]);
    assert.equal(fetchMock.mock.callCount(), 0);
});
