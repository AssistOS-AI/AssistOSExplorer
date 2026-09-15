import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isOnlyOfficeEditorActive,
    renderOnlyOfficeEditor
} from '../../services/onlyoffice/onlyoffice-editor-host.js';

function createHost() {
    const children = [];
    return {
        isConnected: true,
        get textContent() {
            return '';
        },
        set textContent(_value) {
            children.splice(0, children.length);
        },
        appendChild(child) {
            children.push(child);
            return child;
        },
        querySelector(selector) {
            if (selector === '.onlyoffice-editor-frame') {
                return children.find((child) => child.className === 'onlyoffice-editor-frame') || null;
            }
            if (selector === 'iframe') {
                return children.find((child) => child.tagName === 'IFRAME') || null;
            }
            return null;
        }
    };
}

test('native disconnect warnings retire only their current editor and preserve ordinary warnings', async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const mounted = [];
    const observed = [];
    try {
        globalThis.window = { DocsAPI: { DocEditor: class {
            constructor(_id, config) { mounted.push(config); }
            destroyEditor() {}
        } } };
        globalThis.document = { createElement: () => ({ className: '', id: '' }) };
        for (const code of [-100, -101, -104, -120, -121, -122, -62, 500]) {
            const host = createHost();
            const config = {
                document: { key: `session-${code}`, title: 'report.docx', fileType: 'docx' },
                documentServerUrl: 'http://office.test',
                events: { onWarning(event) { observed.push({ receiver: this, event }); } },
            };
            await renderOnlyOfficeEditor(host, config);
            const oldMount = mounted.at(-1);
            const receiver = { code };
            const event = { data: { warningCode: code } };
            oldMount.events.onWarning.call(receiver, event);
            assert.deepEqual(observed.at(-1), { receiver, event });
            const ordinary = [-62, 500].includes(code);
            assert.equal(isOnlyOfficeEditorActive(host, config), ordinary, `warning ${code}`);
            const next = { ...config, document: { ...config.document, key: `next-${code}` } };
            await renderOnlyOfficeEditor(host, next);
            oldMount.events.onWarning(event);
            assert.equal(isOnlyOfficeEditorActive(host, next), true, 'old events cannot retire a new session');
        }
    } finally {
        if (originalWindow === undefined) delete globalThis.window;
        else globalThis.window = originalWindow;
        if (originalDocument === undefined) delete globalThis.document;
        else globalThis.document = originalDocument;
    }
});

test('a superseded async OnlyOffice mount cannot instantiate a stale editor', async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const scripts = [];
    const createdConfigs = [];

    try {
        globalThis.window = {};
        globalThis.document = {
            head: {
                appendChild(script) {
                    scripts.push(script);
                    return script;
                }
            },
            querySelector() {
                return null;
            },
            createElement(tagName) {
                const listeners = new Map();
                return {
                    tagName: String(tagName).toUpperCase(),
                    className: '',
                    id: '',
                    dataset: {},
                    addEventListener(type, listener) {
                        listeners.set(type, listener);
                    },
                    dispatch(type) {
                        listeners.get(type)?.();
                    }
                };
            }
        };

        const host = createHost();
        host.__onlyOfficeRuntime = {
            editor: null,
            containerId: '',
            scriptUrl: '',
            configKey: '',
            renderGeneration: 0,
            inactiveRenderGeneration: 0
        };
        const firstConfig = {
            document: { key: 'first', title: 'first.docx', fileType: 'docx' },
            documentServerUrl: 'http://office.test'
        };
        const secondConfig = {
            document: { key: 'second', title: 'second.docx', fileType: 'docx' },
            documentServerUrl: 'http://office.test'
        };

        const firstMount = renderOnlyOfficeEditor(host, firstConfig);
        const secondMount = renderOnlyOfficeEditor(host, secondConfig);
        assert.equal(scripts.length, 1);

        globalThis.window.DocsAPI = {
            DocEditor: class {
                constructor(_containerId, config) {
                    createdConfigs.push(config);
                }
                destroyEditor() {}
            }
        };
        scripts[0].dispatch('load');
        await Promise.all([firstMount, secondMount]);

        assert.equal(createdConfigs.length, 1);
        assert.equal(createdConfigs[0].document.key, secondConfig.document.key);
        assert.equal(host.__onlyOfficeRuntime.configKey.includes('"second"'), true);
        assert.equal(host.__onlyOfficeRuntime.renderGeneration, 2);
    } finally {
        if (originalWindow === undefined) {
            delete globalThis.window;
        } else {
            globalThis.window = originalWindow;
        }
        if (originalDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = originalDocument;
        }
    }
});

test('the current editor error makes only its generation non-reusable without retrying and preserves the caller handler', async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const createdConfigs = [];
    const callerEvents = [];

    try {
        globalThis.window = {
            DocsAPI: {
                DocEditor: class {
                    constructor(_containerId, config) {
                        createdConfigs.push(config);
                    }
                    destroyEditor() {}
                }
            }
        };
        globalThis.document = {
            createElement(tagName) {
                return {
                    tagName: String(tagName).toUpperCase(),
                    className: '',
                    id: ''
                };
            }
        };

        const host = createHost();
        const config = {
            document: {
                key: 'current',
                title: 'current.docx',
                fileType: 'docx',
                permissions: { edit: true },
                info: {
                    owner: 'User One'
                }
            },
            documentServerUrl: 'http://office.test',
            editorConfig: {
                mode: 'edit',
                user: { id: 'user-1', name: 'User One' }
            },
            token: 'signed-config-token',
            events: {
                onError(event) {
                    callerEvents.push({ receiver: this, event });
                }
            }
        };
        const originalConfig = structuredClone({
            ...config,
            events: undefined
        });

        await renderOnlyOfficeEditor(host, config);
        assert.equal(createdConfigs.length, 1);
        assert.equal(isOnlyOfficeEditorActive(host, config), true);

        const event = { data: { errorCode: -4 } };
        const receiver = { source: 'onlyoffice-sdk' };
        createdConfigs[0].events.onError.call(receiver, event);
        await renderOnlyOfficeEditor(host, config);

        assert.equal(isOnlyOfficeEditorActive(host, config), false);
        assert.equal(host.__onlyOfficeRuntime.inactiveRenderGeneration, 1);
        assert.deepEqual(callerEvents, [{ receiver, event }]);
        assert.equal(createdConfigs.length, 1);
        assert.deepEqual({
            ...config,
            events: undefined
        }, originalConfig);
        assert.equal(createdConfigs[0].token, config.token);
        assert.notEqual(createdConfigs[0], config);
        assert.notEqual(createdConfigs[0].document, config.document);
        assert.notEqual(createdConfigs[0].document.info, config.document.info);
        assert.notEqual(createdConfigs[0].editorConfig, config.editorConfig);
    } finally {
        if (originalWindow === undefined) {
            delete globalThis.window;
        } else {
            globalThis.window = originalWindow;
        }
        if (originalDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = originalDocument;
        }
    }
});

test('an error from a superseded editor generation cannot invalidate the newer editor', async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const createdConfigs = [];
    const callerErrors = [];

    try {
        globalThis.window = {
            DocsAPI: {
                DocEditor: class {
                    constructor(_containerId, config) {
                        createdConfigs.push(config);
                    }
                    destroyEditor() {}
                }
            }
        };
        globalThis.document = {
            createElement(tagName) {
                return {
                    tagName: String(tagName).toUpperCase(),
                    className: '',
                    id: ''
                };
            }
        };

        const host = createHost();
        const firstConfig = {
            document: { key: 'first', title: 'first.docx', fileType: 'docx' },
            documentServerUrl: 'http://office.test',
            events: {
                onError(event) {
                    callerErrors.push(['first', event]);
                }
            }
        };
        const secondConfig = {
            document: { key: 'second', title: 'second.docx', fileType: 'docx' },
            documentServerUrl: 'http://office.test'
        };

        await renderOnlyOfficeEditor(host, firstConfig);
        await renderOnlyOfficeEditor(host, secondConfig);
        assert.equal(createdConfigs.length, 2);
        assert.equal(isOnlyOfficeEditorActive(host, secondConfig), true);

        const staleEvent = { data: { errorCode: -4 } };
        createdConfigs[0].events.onError(staleEvent);

        assert.deepEqual(callerErrors, [['first', staleEvent]]);
        assert.equal(host.__onlyOfficeRuntime.renderGeneration, 2);
        assert.equal(host.__onlyOfficeRuntime.inactiveRenderGeneration, 0);
        assert.equal(isOnlyOfficeEditorActive(host, secondConfig), true);
        assert.equal(createdConfigs.length, 2);
    } finally {
        if (originalWindow === undefined) {
            delete globalThis.window;
        } else {
            globalThis.window = originalWindow;
        }
        if (originalDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = originalDocument;
        }
    }
});

test('disconnect status asset is loaded from the mounted native version before completion', async () => {
    const { preloadOnlyOfficeStatusAsset } = await import('../../services/onlyoffice/onlyoffice-editor-host.js');
    const base = 'http://localhost:8080/base-agent-additional-server/onlyOffice/8080';
    const image = {};
    const host = { querySelector: () => ({ src: `${base}/9.3.1-build/web-apps/apps/documenteditor/main/index.html?token=unused` }) };
    let completed = false;
    const pending = preloadOnlyOfficeStatusAsset(host, base, { createImage: () => image }).then(() => { completed = true; });
    await Promise.resolve();
    assert.equal(completed, false);
    assert.equal(image.src, `${base}/9.3.1-build/web-apps/apps/common/main/resources/img/controls/warnings_s.svg`);
    image.onload();
    await pending;
    assert.equal(completed, true);
});

test('status preload rejects cross-route frames and propagates missing assets', async () => {
    const { preloadOnlyOfficeStatusAsset } = await import('../../services/onlyoffice/onlyoffice-editor-host.js');
    const base = 'http://localhost:8080/base-agent-additional-server/onlyOffice/8080';
    for (const src of ['https://outside.example/web-apps/apps/documenteditor/main/index.html', 'http://localhost:8080/other/web-apps/apps/documenteditor/main/index.html']) {
        await assert.rejects(() => preloadOnlyOfficeStatusAsset({ querySelector: () => ({ src }) }, base, {
            createImage: () => assert.fail('must not request outside editor route'),
        }), /outside its configured route/);
    }
    const image = {};
    const pending = preloadOnlyOfficeStatusAsset({ querySelector: () => ({ src: `${base}/web-apps/apps/documenteditor/main/index.html` }) }, base, { createImage: () => image });
    image.onerror();
    await assert.rejects(() => pending, /could not load/);
});
