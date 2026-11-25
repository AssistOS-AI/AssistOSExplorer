import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SMOKE_BASE_URL ||= 'http://localhost:8080';

const { createFrameRequestLedger, describeWebMeetSettleState, WEBMEET_SETTLE_QUIET_MS } = await import('./webmeet-settle.mjs');

function frameTree() {
    const main = { parentFrame: () => null };
    const panel = { parentFrame: () => main };
    const nested = { parentFrame: () => panel };
    const other = { parentFrame: () => main };
    return { main, panel, nested, other };
}

function clock(start = 1_000) {
    let now = start;
    return { now: () => now, advance: (ms) => { now += ms; } };
}

const idleDocument = { readyState: 'complete', loading: false, joining: false, leaving: false, switching: false };
const roomLoader = 'http://localhost:8080/webmeetAgent/roomLoader.html';

test('the ledger reports only the requests of a frame and its child frames', () => {
    const time = clock();
    const { main, panel, nested, other } = frameTree();
    const ledger = createFrameRequestLedger({ now: time.now });
    const own = {};
    const child = {};
    const unrelated = {};
    ledger.start(own, panel, { method: 'get', url: 'http://localhost:8080/auth/token?mutationRoute=webmeetAgent' });
    ledger.start(child, nested, { method: 'GET', url: 'http://localhost:8080/webmeetAgent/a.css' });
    ledger.start(unrelated, other, { method: 'GET', url: 'http://localhost:8080/explorer/b.js' });
    assert.deepEqual(ledger.snapshot(panel).pending, ['GET /auth/token', 'GET /webmeetAgent/a.css'], 'queries are never reported');
    assert.equal(ledger.snapshot(main).pending.length, 3);
    ledger.end(own);
    ledger.end(child);
    assert.deepEqual(ledger.snapshot(panel).pending, []);
    assert.deepEqual(ledger.snapshot(other).pending, ['GET /explorer/b.js']);
});

test('the quiet time restarts at every start and end in the subtree, and ignores other frames', () => {
    const time = clock();
    const { panel, other } = frameTree();
    const ledger = createFrameRequestLedger({ now: time.now });
    assert.equal(ledger.snapshot(panel).quietForMs, Infinity, 'a frame with no request has been quiet forever');
    const request = {};
    ledger.start(request, panel, { method: 'GET', url: 'http://localhost:8080/x' });
    time.advance(400);
    ledger.end(request);
    time.advance(300);
    assert.equal(ledger.snapshot(panel).quietForMs, 300);
    ledger.start({}, other, { method: 'GET', url: 'http://localhost:8080/y' });
    time.advance(50);
    assert.equal(ledger.snapshot(panel).quietForMs, 350, 'another frame does not reset the quiet time');
});

test('an unknown or repeated end changes nothing', () => {
    const time = clock();
    const { panel } = frameTree();
    const ledger = createFrameRequestLedger({ now: time.now });
    const request = {};
    ledger.start(request, panel, { method: 'GET', url: 'http://localhost:8080/x' });
    ledger.end(request);
    time.advance(500);
    ledger.end(request);
    ledger.end({});
    assert.deepEqual(ledger.snapshot(panel), { pending: [], quietForMs: 500 });
});

test('a frame settles only at the room loader, loaded, idle, with no request for the quiet time', () => {
    const quiet = { pending: [], quietForMs: WEBMEET_SETTLE_QUIET_MS };
    const settled = (overrides = {}) => describeWebMeetSettleState({
        url: roomLoader, documentState: idleDocument, network: quiet, ...overrides,
    });
    assert.equal(settled(), 'settled');
    assert.equal(settled({ url: `${roomLoader}?roomId=room_1` }), 'settled', 'a room link is still the room loader');
    assert.match(settled({ url: 'about:blank' }), /room loader document/);
    assert.match(settled({ url: 'http://127.0.0.1:8080/webmeetAgent/roomLoader.html' }), /room loader document/, 'another origin is not the WebMeet under test');
    assert.match(settled({ documentState: null }), /accept evaluation/);
    assert.match(settled({ documentState: { ...idleDocument, readyState: 'interactive' } }), /to load/);
    assert.match(settled({ documentState: { ...idleDocument, loading: true } }), /room loader to finish/);
    assert.match(settled({ documentState: { ...idleDocument, joining: true } }), /join/);
    assert.match(settled({ documentState: { ...idleDocument, leaving: true } }), /leave/);
    assert.match(settled({ documentState: { ...idleDocument, switching: true } }), /transition/);
    assert.equal(settled({ network: { pending: ['GET /auth/token'], quietForMs: 5_000 } }),
        'waiting for in-flight WebMeet requests: GET /auth/token');
    assert.match(settled({ network: { pending: [], quietForMs: WEBMEET_SETTLE_QUIET_MS - 1 } }), /without WebMeet requests/);
});
