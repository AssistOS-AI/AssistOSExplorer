import assert from 'node:assert/strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// Keep only stream/message identities and timing. Session contents, headers and other event data are never retained.
export function createHSessionObserverState({ baseURL, agent, robot, directory }) {
    const origin = new URL(baseURL).origin;
    let stream = null;
    let currentSessionId = null;
    let sequence = 0;
    let failure = null;
    let claimedSessionId = null;
    const records = [];
    const capture = (action) => { if (!failure) try { action(); } catch (error) { failure = error; } };
    const healthy = () => {
        if (failure) throw failure;
        assert.ok(stream && !stream.closed, 'The exact H WebChat stream is present and active');
    };
    const sameStream = (mark) => {
        healthy();
        for (const key of ['requestId', 'tabId', 'pageInstanceId']) assert.equal(mark[key], stream[key], 'H stream binding did not change');
    };
    const state = {
        request(event) {
            capture(() => {
                const url = new URL(event.request.url);
                if (url.origin !== origin || url.pathname !== '/webchat/stream' || url.searchParams.get('agent') !== agent
                    || url.searchParams.get('robot') !== robot || url.searchParams.get('workspace-dir') !== directory) return;
                assert.equal(event.request.method, 'GET');
                assert.equal(event.type, 'EventSource');
                assert.ok(!event.redirectResponse, 'The H stream is not a redirected request');
                assert.ok(typeof event.requestId === 'string' && event.requestId, 'The H stream has a CDP request ID');
                assert.equal(stream, null, 'H has exactly one unambiguous stream binding');
                const tabId = url.searchParams.get('tabId');
                const pageInstanceId = url.searchParams.get('pageInstanceId');
                assert.ok(tabId && pageInstanceId, 'The H stream identifies its tab and page instance');
                stream = { requestId: event.requestId, tabId, pageInstanceId, at: event.timestamp, closed: false };
            });
        },
        message(event) {
            capture(() => {
                if (!stream || event.requestId !== stream.requestId || event.eventName !== 'session-state') return;
                assert.ok(!stream.closed, 'H session messages arrive on the active bound stream');
                let payload;
                try { payload = JSON.parse(event.data); }
                catch { throw Object.assign(new Error('Invalid H session-state JSON'), { code: 'H_SESSION_STATE_INVALID_JSON' }); }
                const targets = [['targetTabId', stream.tabId], ['targetPageInstanceId', stream.pageInstanceId]];
                for (const [key, expected] of targets) {
                    assert.ok(payload[key] === undefined || typeof payload[key] === 'string', 'Session target identities are strings or absent');
                    if (payload[key] && payload[key] !== expected) return;
                }
                if (payload.event === 'list') {
                    assert.match(payload.currentSessionId || '', UUID, 'The connection list identifies its current conversation');
                    currentSessionId = payload.currentSessionId;
                    records.push({ sequence: ++sequence, event: 'list', currentSessionId, at: event.timestamp });
                } else if (['current', 'selected', 'updated'].includes(payload.event)) {
                    assert.match(payload.session?.sessionId || '', UUID, 'Session state identifies a valid conversation');
                    assert.equal(payload.session.sessionId, payload.summary?.sessionId, 'Session and summary identities agree');
                    if (payload.event !== 'updated') {
                        if (claimedSessionId) {
                            assert.equal(payload.session.sessionId, claimedSessionId, 'The claimed H conversation did not swap');
                            assert.notEqual(payload.event, 'selected', 'No second selection replaced the claimed New response');
                        }
                        currentSessionId = payload.session.sessionId;
                    }
                    records.push({ sequence: ++sequence, event: payload.event, sessionId: payload.session.sessionId, at: event.timestamp });
                }
            });
        },
        ended(event) {
            if (stream && event.requestId === stream.requestId) stream.closed = true;
        },
        checkpoint() {
            healthy();
            return { requestId: stream.requestId, tabId: stream.tabId, pageInstanceId: stream.pageInstanceId, sequence, currentSessionId };
        },
        listAfter(mark) {
            sameStream(mark);
            const found = records.filter((row) => row.sequence > mark.sequence && row.event === 'list');
            assert.ok(found.length <= 1, 'Sessions click has one unambiguous list response');
            return found.length ? { ...mark, ...found[0] } : null;
        },
        selectedAfter(mark, baseline) {
            sameStream(mark);
            sameStream(baseline);
            assert.ok(mark.sequence >= baseline.sequence, 'New follows the observed list response');
            assert.equal(mark.currentSessionId, baseline.currentSessionId, 'The baseline binding stayed current before New');
            const found = records.filter((row) => row.sequence > mark.sequence && row.event === 'selected');
            assert.ok(found.length <= 1, 'New has one unambiguous selected response');
            if (!found.length) return null;
            const selected = { ...mark, ...found[0], previousSessionId: baseline.currentSessionId };
            assert.notEqual(selected.sessionId, baseline.currentSessionId, 'New selects a different conversation UUID');
            state.assertSelected(selected);
            claimedSessionId = selected.sessionId;
            return selected;
        },
        assertSelected(selected) {
            sameStream(selected);
            assert.equal(currentSessionId, selected.sessionId, 'The observed selected conversation did not swap');
            assert.ok(!records.some((row) => row.sequence > selected.sequence && row.event === 'selected'), 'No later selection replaced the New response');
        },
        assertNoFailure() { if (failure) throw failure; },
        evidence() { return { stream: stream && { ...stream }, records: records.map((row) => ({ ...row })), failure: failure?.message || null }; },
    };
    return state;
}

export async function observeHSessionSelection(page, scope) {
    const cdp = await page.context().newCDPSession(page);
    const state = createHSessionObserverState(scope);
    const events = [['Network.requestWillBeSent', state.request], ['Network.eventSourceMessageReceived', state.message],
        ['Network.loadingFinished', state.ended], ['Network.loadingFailed', state.ended]];
    for (const [name, handler] of events) cdp.on(name, handler);
    const dispose = async () => {
        for (const [name, handler] of events) cdp.off(name, handler);
        await cdp.detach();
    };
    try { await cdp.send('Network.enable'); }
    catch (error) {
        try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], error.message, { cause: error }); }
        throw error;
    }
    return { ...state, dispose };
}
