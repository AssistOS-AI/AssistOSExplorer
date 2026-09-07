import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConfigKey } from '../../services/onlyoffice/onlyoffice-editor-host.js';
import { tryLoadOnlyOfficePreview } from '../../services/onlyoffice/onlyoffice-preview-service.js';

function createSession(documentKey) {
    return {
        config: {
            document: {
                key: documentKey,
                title: 'report.docx',
                fileType: 'docx',
                permissions: { edit: true }
            },
            documentServerUrl: 'http://office.test',
            editorConfig: {
                mode: 'edit',
                user: { id: 'user-1' }
            },
            token: `signed-token-${documentKey}`
        },
        preview: {
            objectId: 'dpu-object-1',
            canWrite: true,
            canComment: false
        }
    };
}

test('an explicit no-version DPU reopen obtains a fresh session after the current editor generation fails', async () => {
    const originalFetch = globalThis.fetch;
    const firstSession = createSession('session-1');
    const secondSession = createSession('session-2');
    let slotValue = {
        path: '/dpu/report.docx',
        session: firstSession,
        versionHint: '',
        fetchedAt: Date.now()
    };
    let fetchCalls = 0;
    let invalidations = 0;
    let refreshes = 0;
    const previewStates = [];
    const host = {
        isConnected: true,
        __onlyOfficeRuntime: {
            editor: {},
            containerId: 'onlyoffice-editor-1',
            scriptUrl: 'http://office.test/web-apps/apps/api/documents/api.js',
            configKey: buildConfigKey(firstSession.config),
            renderGeneration: 1,
            inactiveRenderGeneration: 1
        },
        querySelector(selector) {
            return selector === 'iframe' ? { tagName: 'IFRAME' } : null;
        }
    };
    const fileExp = {
        normalizePath(path) {
            return path;
        },
        caches: {
            officeSession: {
                get() {
                    return slotValue;
                },
                set(value) {
                    slotValue = value;
                },
                clear() {
                    slotValue = null;
                },
                invalidateForPath() {}
            }
        },
        previewDom: {
            componentMount: host
        },
        getEntryByPath() {
            return {
                path: '/dpu/report.docx'
            };
        },
        setPreviewState(state) {
            previewStates.push(state);
        },
        invalidate() {
            invalidations += 1;
        },
        refreshPreviewUi() {
            refreshes += 1;
        }
    };

    try {
        globalThis.fetch = async () => {
            fetchCalls += 1;
            return new Response(JSON.stringify(secondSession), {
                status: 200,
                headers: {
                    'content-type': 'application/json'
                }
            });
        };

        assert.equal(fetchCalls, 0);
        assert.equal(invalidations, 0);
        assert.equal(refreshes, 0);

        const loaded = await tryLoadOnlyOfficePreview(fileExp, '/dpu/report.docx');

        assert.equal(loaded, true);
        assert.equal(fetchCalls, 1);
        assert.deepEqual(slotValue.session, secondSession);
        assert.equal(slotValue.versionHint, '');
        assert.equal(previewStates.length, 1);
        assert.deepEqual(previewStates[0].onlyOfficeConfig, secondSession.config);
        assert.equal(invalidations, 1);
        assert.equal(refreshes, 0);
    } finally {
        if (originalFetch === undefined) {
            delete globalThis.fetch;
        } else {
            globalThis.fetch = originalFetch;
        }
    }
});

test('OnlyOffice startup failures switch the preview to the shared runtime loader', async () => {
    const originalFetch = globalThis.fetch;
    const previewStates = [];
    let invalidations = 0;
    const fileExp = {
        normalizePath(path) {
            return path;
        },
        caches: {
            officeSession: {
                get() { return null; },
                set() {},
                clear() {},
                invalidateForPath() {}
            }
        },
        setPreviewState(state) {
            previewStates.push(state);
        },
        invalidate() {
            invalidations += 1;
        },
        refreshPreviewUi() {}
    };

    try {
        globalThis.fetch = async () => new Response(JSON.stringify({ error: 'agent_not_ready' }), {
            status: 503,
            headers: { 'content-type': 'application/json' }
        });
        const loaded = await tryLoadOnlyOfficePreview(fileExp, '/report.docx');
        assert.equal(loaded, true);
        assert.equal(invalidations, 1);
        assert.deepEqual(previewStates[0].onlyOfficeRuntimeState, { path: '/report.docx' });
        assert.equal(previewStates[0].onlyOfficeConfig, null);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('OnlyOffice document 404 remains a domain error instead of entering the runtime loader', async () => {
    const originalFetch = globalThis.fetch;
    const previewStates = [];
    const fileExp = {
        normalizePath(path) {
            return path;
        },
        caches: {
            officeSession: {
                get() { return null; },
                set() {},
                clear() {},
                invalidateForPath() {}
            }
        },
        setPreviewState(state) {
            previewStates.push(state);
        },
        invalidate() {},
        refreshPreviewUi() {}
    };

    try {
        globalThis.fetch = async () => new Response(JSON.stringify({ error: 'document not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' }
        });
        await assert.rejects(
            () => tryLoadOnlyOfficePreview(fileExp, '/missing.docx'),
            (error) => error.status === 404 && error.message === 'document not found'
        );
        assert.deepEqual(previewStates, []);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('disabled OnlyOffice with a missing route opens the runtime guidance instead of a document error', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async (url) => new Response(JSON.stringify(
        url === '/api/marketplace'
            ? { agents: [{ ref: 'AchillesIDE/onlyOffice', active: false, status: 'disabled' }] }
            : { error: 'route not found' }
    ), { status: url === '/api/marketplace' ? 200 : 404, headers: { 'content-type': 'application/json' } });
    let preview;
    const fileExp = {
        normalizePath: (path) => path,
        caches: { officeSession: { get() { return null; }, set() {}, clear() {} } },
        setPreviewState: (state) => { preview = state; },
        invalidate() {}
    };
    assert.equal(await tryLoadOnlyOfficePreview(fileExp, '/report.docx'), true);
    assert.equal(preview.previewMode, 'onlyoffice');
    assert.deepEqual(preview.onlyOfficeRuntimeState, { path: '/report.docx' });
});
