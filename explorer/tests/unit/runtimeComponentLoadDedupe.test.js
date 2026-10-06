import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createComponentRegistry } from '../../services/runtime/componentRegistry.js';

function createFixture(t, name) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-dedupe-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const importLog = `__explorerDedupeImports_${name}`;
    fs.writeFileSync(
        path.join(directory, 'widget.js'),
        `(globalThis.${importLog} ||= []).push(import.meta.url);\nexport class Widget {}\n`
    );

    const fetched = [];
    const originalFetch = globalThis.fetch;
    const failures = new Set();
    globalThis.fetch = async (url) => {
        const text = String(url);
        fetched.push(text);
        if (failures.has(text.replace(/^.*\./, ''))) {
            return { ok: false, status: 404, async text() { return 'missing'; } };
        }
        return { ok: true, status: 200, async text() { return text.endsWith('.html') ? '<main></main>' : '.widget {}'; } };
    };
    const originalCustomElements = globalThis.customElements;
    globalThis.customElements = { get: () => undefined };
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (originalCustomElements === undefined) delete globalThis.customElements;
        else globalThis.customElements = originalCustomElements;
        delete globalThis[importLog];
    });

    const registrations = [];
    let failNextRegistration = false;
    const webSkel = {
        configs: { components: [] },
        async defineComponent(definition) {
            registrations.push(definition.name);
            if (failNextRegistration) {
                failNextRegistration = false;
                throw new Error('registration rejected');
            }
        },
        ResourceManager: {
            components: {},
            registerPresenter() {},
            async unloadStyleSheets() {},
            async loadStyleSheets() {}
        }
    };
    const meta = {
        agent: 'demoAgent',
        componentName: 'demo-widget',
        presenterName: 'Widget',
        baseUrl: `file://${directory}/widget`.replace(/\.js$/, '')
    };
    return {
        registry: createComponentRegistry(webSkel),
        meta,
        fetched,
        failures,
        registrations,
        imports: () => globalThis[importLog] || [],
        failNextRegistration() { failNextRegistration = true; }
    };
}

test('T1: overlapping loads of one component share one fetch pair, one import and one registration', async (t) => {
    const fixture = createFixture(t, 'overlap');

    const [first, second] = await Promise.all([
        fixture.registry.loadComponent(fixture.meta),
        fixture.registry.loadComponent(fixture.meta)
    ]);

    assert.equal(first, second, 'both callers resolve the same component object');
    assert.equal(fixture.fetched.length, 2, `html and css once: ${fixture.fetched.join(', ')}`);
    assert.equal(fixture.imports().length, 1, 'one presenter module instance');
    assert.equal(fixture.registrations.length, 1);

    const again = await fixture.registry.loadComponent(fixture.meta);
    assert.equal(again, first);
    assert.equal(fixture.fetched.length, 2, 'a loaded component is served from the cache');
});

test('T1: a rejected load leaves nothing behind, and the retry fetches again with a fresh runtimeImport URL', async (t) => {
    const fixture = createFixture(t, 'retry');
    fixture.failNextRegistration();

    const results = await Promise.allSettled([
        fixture.registry.loadComponent(fixture.meta),
        fixture.registry.loadComponent(fixture.meta)
    ]);
    assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
    assert.equal(fixture.fetched.length, 2, 'the overlapping failed callers shared one load');
    assert.equal(fixture.imports().length, 1);

    const retried = await fixture.registry.loadComponent(fixture.meta);
    assert.equal(retried.name, 'demo-widget');
    assert.equal(fixture.fetched.length, 4, 'the retry fetched html and css again');
    const imports = fixture.imports();
    assert.equal(imports.length, 2);
    assert.notEqual(imports[0], imports[1], 'the retry imported a new module URL');
    for (const url of imports) assert.match(url, /\?runtimeImport=/);
    assert.equal(fixture.registrations.length, 2);
});

test('T1: a component whose assets fail to load is not cached and the next call starts over', async (t) => {
    const fixture = createFixture(t, 'assets');
    fixture.failures.add('css');

    await assert.rejects(fixture.registry.loadComponent(fixture.meta), /Failed to load stylesheet/);
    const fetchedBefore = fixture.fetched.length;
    fixture.failures.clear();
    const loaded = await fixture.registry.loadComponent(fixture.meta);

    assert.equal(loaded.name, 'demo-widget');
    assert.equal(fixture.fetched.length, fetchedBefore + 2);
});
