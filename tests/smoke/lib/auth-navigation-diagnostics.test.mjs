import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { GOOGLE_SIGN_IN_SCRIPT_URL, beginAuthNavigationDiagnostics } from './auth-navigation-diagnostics.mjs';
import {
    acknowledgePageNavigationCancellation,
    attachPageDiagnostics,
    checkpointPageDiagnostics,
    closePageDiagnosticsCheckpoint,
    recordPageNavigationFailure,
} from './fixtures.mjs';

test('failure snapshots retain request terminals and initiators without credential-bearing protocol payloads', async () => {
    const page = new EventEmitter();
    const session = new EventEmitter();
    session.send = async () => {};
    session.detach = async () => {};
    const unsafeUrl = 'https://url-user:url-password@fixture.invalid/script.js?opaque=unknown-secret#private-fragment';
    const frame = { url: () => unsafeUrl };
    page.context = () => ({ newCDPSession: async () => session });
    page.mainFrame = () => frame;
    page.url = () => unsafeUrl;
    const diagnostics = attachPageDiagnostics(page, {}, 'unit');
    const recorder = await beginAuthNavigationDiagnostics(page, { username: 'short', loginEmail: 'private-login@example.test', password: 'pw' });
    const request = (suffix) => ({
        url: () => `https://fixture.invalid/${suffix}?opaque=unknown-secret`, method: () => 'GET',
        resourceType: () => 'script', isNavigationRequest: () => false,
        frame: () => frame, redirectedFrom: () => null, failure: () => ({ errorText: 'net::ERR_FAILED' }),
    });
    const completed = request('complete.js');
    const failed = request('failed.js');
    const pending = request('pending.js');
    for (const entry of [completed, failed, pending]) page.emit('request', entry);
    page.emit('requestfinished', completed);
    page.emit('requestfailed', failed);
    page.emit('framenavigated', frame);
    page.emit('domcontentloaded');
    session.emit('Network.requestWillBeSent', {
        requestId: '1', frameId: 'frame-1', type: 'Script',
        request: { url: unsafeUrl, method: 'GET', headers: { cookie: 'private-cookie' }, postData: 'private-form-body' },
        initiator: { type: 'script', url: unsafeUrl, lineNumber: 2, stack: {
            callFrames: [{ url: unsafeUrl, functionName: 'private-function-sentinel', lineNumber: 3, columnNumber: 4 }],
        } },
    });
    session.emit('Network.responseReceived', {
        requestId: '1', response: { status: 200, protocol: 'h3', headers: { 'set-cookie': 'private-response-cookie' } },
    });
    session.emit('Network.loadingFailed', { requestId: '1', errorText: 'net::ERR_FAILED' });
    const error = new Error(`navigation to ${unsafeUrl} failed for short pw private-login@example.test private-login%40example.test`);
    const snapshot = recorder.failure(error, 'login-submit-navigation');
    recordPageNavigationFailure(page, snapshot);
    assert.equal(error.navigationDiagnostics, snapshot);
    assert.deepEqual(snapshot.requests.map(({ state }) => state), ['finished', 'failed', 'pending']);
    assert.equal(snapshot.pending.length, 1);
    assert.equal(snapshot.protocolRequests[0].state, 'failed');
    assert.equal(snapshot.protocolRequests[0].protocol, 'h3');
    assert.deepEqual(snapshot.protocolRequests[0].initiator.stack, [{ url: 'https://fixture.invalid/script.js', lineNumber: 3, columnNumber: 4 }]);
    assert.equal(diagnostics.actionableEvents().length, 1, 'navigation metadata does not acknowledge the real failed request');
    const captured = JSON.stringify({ snapshot, message: error.message, stack: error.stack });
    for (const value of ['url-user', 'url-password', 'unknown-secret', 'private-fragment', 'private-cookie', 'private-form-body',
        'private-function-sentinel', 'private-response-cookie', 'short', 'pw', 'private-login@example.test', 'private-login%40example.test']) {
        assert.equal(captured.includes(value), false, value);
    }
    page.emit('requestfinished', pending);
    assert.equal(snapshot.pending[0].state, 'pending', 'snapshot retains failure-time state');
    await recorder.dispose();
    assert.equal(page.listenerCount('request'), 0);
    assert.equal(session.eventNames().length, 0);
    assert.equal(page.listenerCount('requestfailed'), 1, 'the pre-existing diagnostic listener is preserved');
});

test('unavailable CDP is explicit and preserves the Playwright failure evidence', async () => {
    const page = new EventEmitter();
    page.context = () => ({ newCDPSession: async () => { throw new Error('not supported'); } });
    page.url = () => 'about:blank';
    const recorder = await beginAuthNavigationDiagnostics(page, {});
    const snapshot = recorder.failure(new Error('first navigation failure'), 'login-navigation');
    assert.equal(snapshot.protocolAvailable, false);
    assert.equal(snapshot.failure.message, 'first navigation failure');
    assert.deepEqual(snapshot.requests, []);
    await recorder.dispose();
    assert.equal(page.eventNames().length, 0);
});

// ---- navigation-cancellation proof over a synthetic protocol timeline ------
const ORIGIN = 'http://127.0.0.1:8080';
const WIZARD = '/base-agent-additional-server/userPersistoAgent/7000/service/auth/';
const GIS = GOOGLE_SIGN_IN_SCRIPT_URL;
const PRIVATE = ['private-request', 'private-state', 'private-code', 'private-user', 'private@example.test', 'private-password'];

// A wizard document F/L1 loads the Google script, submits a password and is
// replaced by the callback document L2, which redirects to /destination.
async function proveScenario(changes = {}) {
    const o = {
        cdp: true, bind: true, frameTreeFails: false, frameTreeUrl: null, frameParent: undefined,
        gis: true, gisUrl: GIS, gisMethod: 'GET', gisType: 'Script', pwType: 'script', gisFrame: 'F', gisLoader: 'L1',
        pwMainFrame: true, serviceWorker: false, navigation: false, gisRedirect: false, pwRedirect: false, duplicate: false,
        gisTerminal: 'failed', failText: 'net::ERR_ABORTED', pwFailText: 'net::ERR_ABORTED', gisFailAt: 1.32, cdpFailure: true, pwFailure: true,
        login: true, loginStatus: 200, extraDocument: false, callbackOrigin: ORIGIN, callbackPath: '/auth/callback',
        destination: '/destination', returnTo: '/destination', load: true, flood: 0, ...changes,
    };
    const page = new EventEmitter();
    const session = new EventEmitter();
    let current = `${ORIGIN}${WIZARD}?requestId=private-request&state=private-state`;
    const mainFrame = { url: () => current };
    page.mainFrame = () => mainFrame;
    page.url = () => current;
    session.send = async (method) => {
        if (method !== 'Page.getFrameTree') return {};
        if (o.frameTreeFails) throw new Error('frame tree unavailable');
        return { frameTree: { frame: { id: 'F', loaderId: 'L1', url: o.frameTreeUrl || current, ...(o.frameParent ? { parentId: o.frameParent } : {}) } } };
    };
    session.detach = async () => {};
    page.context = () => ({ newCDPSession: async () => { if (!o.cdp) throw new Error('unsupported'); return session; } });
    const diagnostics = attachPageDiagnostics(page, {}, 'unit');
    const checkpoint = checkpointPageDiagnostics(page, 'authentication navigation');
    const recorder = await beginAuthNavigationDiagnostics(page, { username: 'private-user', loginEmail: 'private@example.test', password: 'private-password' });
    const cdp = (name, data) => session.emit(name, data);
    const documentRequest = (id, at, url) => cdp('Network.requestWillBeSent', { requestId: id, loaderId: id, frameId: 'F', type: 'Document', timestamp: at, request: { url, method: 'GET' } });
    documentRequest('L1', 1.0, current);
    cdp('Network.responseReceived', { requestId: 'L1', response: { status: 200 } });
    cdp('Network.loadingFinished', { requestId: 'L1', timestamp: 1.01 });
    cdp('Page.lifecycleEvent', { name: 'load', frameId: 'F', loaderId: 'L1', timestamp: 1.02 });
    const scripts = [];
    for (const id of o.gis ? (o.duplicate ? ['R1', 'R2'] : ['R1']) : []) {
        cdp('Network.requestWillBeSent', { requestId: id, loaderId: o.gisLoader, frameId: o.serviceWorker ? undefined : o.gisFrame, type: o.gisType,
            timestamp: 1.1, request: { url: o.gisUrl, method: o.gisMethod } });
        if (o.gisRedirect) {
            cdp('Network.requestWillBeSent', { requestId: id, loaderId: o.gisLoader, frameId: o.gisFrame, type: o.gisType, timestamp: 1.11,
                redirectResponse: { status: 302 }, request: { url: o.gisUrl, method: o.gisMethod } });
        }
        const request = {
            url: () => o.gisUrl, method: () => o.gisMethod, resourceType: () => o.pwType, isNavigationRequest: () => o.navigation,
            frame: () => { if (o.serviceWorker) throw new Error('service worker'); return o.pwMainFrame ? mainFrame : {}; },
            redirectedFrom: () => (o.pwRedirect ? {} : null), redirectedTo: () => null, failure: () => ({ errorText: o.pwFailText }),
        };
        page.emit('request', request);
        scripts.push({ id, request });
    }
    const bound = o.bind ? await recorder.bindWizardDocument({ expectedOrigin: ORIGIN, pathname: WIZARD }) : false;
    if (o.login) {
        cdp('Network.requestWillBeSent', { requestId: 'P', loaderId: 'L1', frameId: 'F', type: 'Fetch', timestamp: 1.2,
            request: { url: `${ORIGIN}${WIZARD}password/login`, method: 'POST', postData: 'private-password' } });
        cdp('Network.responseReceived', { requestId: 'P', response: { status: o.loginStatus } });
        cdp('Network.loadingFinished', { requestId: 'P', timestamp: 1.25 });
    }
    if (o.extraDocument) documentRequest('L3', 1.28, `${ORIGIN}/other`);
    documentRequest('L2', 1.3, `${o.callbackOrigin}${o.callbackPath}?code=private-code&state=private-state`);
    cdp('Network.requestWillBeSent', { requestId: 'L2', loaderId: 'L2', frameId: 'F', type: 'Document', timestamp: 1.31,
        redirectResponse: { status: 302 }, request: { url: `${ORIGIN}${o.destination}`, method: 'GET' } });
    cdp('Network.responseReceived', { requestId: 'L2', response: { status: 200 } });
    for (const { id, request } of scripts) {
        if (o.cdpFailure) {
            if (o.gisTerminal === 'failed') cdp('Network.loadingFailed', { requestId: id, errorText: o.failText, canceled: true, timestamp: o.gisFailAt });
            else cdp('Network.loadingFinished', { requestId: id, timestamp: o.gisFailAt });
        }
        if (o.pwFailure) page.emit(o.gisTerminal === 'failed' ? 'requestfailed' : 'requestfinished', request);
    }
    cdp('Network.loadingFinished', { requestId: 'L2', timestamp: 1.33 });
    if (o.load) cdp('Page.lifecycleEvent', { name: 'load', frameId: 'F', loaderId: 'L2', timestamp: 1.34 });
    current = `${ORIGIN}${o.destination}`;
    for (let index = 0; index < o.flood; index += 1) {
        cdp('Network.requestWillBeSent', { requestId: `flood-${index}`, loaderId: 'L2', frameId: 'F', type: 'Image', timestamp: 1.35,
            request: { url: `${ORIGIN}/image-${index}.png`, method: 'GET' } });
    }
    const proof = await recorder.provePasswordNavigation({ expectedOrigin: ORIGIN, returnTo: o.returnTo, timeoutMs: 60 });
    return { proof, bound, page, session, diagnostics, checkpoint, recorder };
}

test('a bound wizard script aborted by its own successful password handoff yields one sanitized proof that the ledger acknowledges once', async () => {
    const { proof, bound, page, session, diagnostics, checkpoint, recorder } = await proveScenario();
    assert.equal(bound, true);
    assert.ok(proof);
    assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.proof) && Object.isFrozen(proof.signature));
    assert.deepEqual(proof.signature, { kind: 'requestfailed', type: 'error', url: GIS, method: 'GET', failure: 'net::ERR_ABORTED' });
    assert.equal(proof.proof.destination, `${ORIGIN}/destination`);
    assert.equal(proof.proof.passwordStatus, 200);
    const timing = proof.proof.timingMs;
    assert.ok(timing.scriptStarted < timing.passwordFinished && timing.passwordFinished <= timing.handoffStarted
        && timing.handoffStarted <= timing.scriptAborted && timing.scriptAborted <= timing.destinationLoaded, JSON.stringify(timing));
    assert.equal(acknowledgePageNavigationCancellation(page, checkpoint, proof), true);
    assert.deepEqual(diagnostics.actionableEvents(), []);
    assert.equal(diagnostics.events.filter(({ kind }) => kind === 'requestfailed').length, 1, 'the original abort is retained');
    const evidence = JSON.stringify({ proof, events: diagnostics.events, snapshot: recorder.failure(new Error('later'), 'after-proof') });
    for (const value of PRIVATE) assert.equal(evidence.includes(value), false, value);
    assert.equal(/"(?:headers|cookies|postData|body)"/.test(evidence), false);
    await recorder.dispose();
    assert.equal(session.eventNames().length, 0);
    assert.equal(page.listenerCount('request'), 0);
});

test('missing, ambiguous or misordered evidence yields no proof and the abort stays actionable', async (t) => {
    const cases = {
        'unsupported CDP': { cdp: false },
        'no bound document': { bind: false },
        'unavailable frame tree': { frameTreeFails: true },
        'binding at another path': { frameTreeUrl: `${ORIGIN}/other/` },
        'binding in a child frame': { frameParent: 'P' },
        'query variant': { gisUrl: `${GIS}?hl=en` },
        'fragment variant': { gisUrl: `${GIS}#private-fragment` },
        'scheme variant': { gisUrl: 'http://accounts.google.com/gsi/client' },
        'port variant': { gisUrl: 'https://accounts.google.com:8443/gsi/client' },
        'host variant': { gisUrl: 'https://accounts.google.com.example/gsi/client' },
        'wrong method': { gisMethod: 'POST' },
        'wrong resource type': { gisType: 'XHR', pwType: 'xhr' },
        'navigation request': { navigation: true },
        'redirected script': { gisRedirect: true, pwRedirect: true },
        'iframe request': { gisFrame: 'F2', pwMainFrame: false },
        'service worker request': { serviceWorker: true },
        'other document loader': { gisLoader: 'L0' },
        'duplicate requests': { duplicate: true },
        'early abort': { gisFailAt: 1.15 },
        'abort after the destination loaded': { gisFailAt: 1.5 },
        'non-abort network failure': { failText: 'net::ERR_CONNECTION_RESET', pwFailText: 'net::ERR_CONNECTION_RESET' },
        'TLS failure': { failText: 'net::ERR_CERT_AUTHORITY_INVALID', pwFailText: 'net::ERR_CERT_AUTHORITY_INVALID' },
        'inconsistent observations': { pwFailText: 'net::ERR_FAILED' },
        'missing Playwright terminal': { pwFailure: false },
        'missing protocol terminal': { cdpFailure: false },
        'failed password': { loginStatus: 401 },
        'no password submission': { login: false },
        'callback at another path': { callbackPath: '/auth/other' },
        'callback at another origin': { callbackOrigin: 'http://localhost:8080' },
        'another destination': { returnTo: '/elsewhere' },
        'another document before the callback': { extraDocument: true },
        'destination not loaded': { load: false },
        'truncated evidence': { flood: 2_001 },
    };
    for (const [name, changes] of Object.entries(cases)) {
        await t.test(name, async () => {
            const { proof, page, diagnostics, checkpoint, recorder } = await proveScenario(changes);
            assert.equal(proof, null);
            closePageDiagnosticsCheckpoint(page, checkpoint);
            const failures = diagnostics.actionableEvents().filter(({ kind }) => kind === 'requestfailed');
            assert.ok(failures.length >= (changes.pwFailure === false ? 0 : 1), 'the original failure is still actionable');
            await recorder.dispose();
        });
    }
    for (const [name, changes] of Object.entries({ 'script loaded': { gisTerminal: 'finished' }, 'script absent': { gis: false } })) {
        await t.test(name, async () => {
            const { proof, diagnostics, recorder } = await proveScenario(changes);
            assert.equal(proof, null, 'nothing needs acknowledgement');
            assert.deepEqual(diagnostics.actionableEvents(), []);
            await recorder.dispose();
        });
    }
});
