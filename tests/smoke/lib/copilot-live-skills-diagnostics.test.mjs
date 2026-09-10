import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { captureLiveSkillsFailure, liveSkillsDiagnosticText, observeLiveSkillsBrowser } from './copilot-live-skills-diagnostics.mjs';
import { createReleaseGateFailureCollector } from './release-gate-failures.mjs';

test('a successful response and later failed request retain their exact correlation and remain fatal', () => {
    const page = new EventEmitter();
    const errors = [], network = [];
    const observer = observeLiveSkillsBrowser({ errors, network, now: () => '2026-09-11T00:00:00.000Z' });
    observer.observe(page);
    observer.observe(page);
    const request = { url: () => 'https://example.test/webchat/input?token=must-not-appear',
        method: () => 'POST', failure: () => ({ errorText: 'net::ERR_ABORTED' }) };
    page.emit('request', request);
    page.emit('response', { request: () => request, status: () => 204 });
    page.emit('requestfailed', request);
    assert.equal(network.length, 2);
    assert.equal(errors.length, 1);
    assert.deepEqual(errors[0], { kind: 'requestfailed', at: '2026-09-11T00:00:00.000Z', pageId: 'page-1',
        requestId: 'request-1', method: 'POST', path: '/webchat/input', responseStatus: 204, failure: 'net::ERR_ABORTED' });
    assert.equal(network[1].requestId, errors[0].requestId);
    assert.ok(!JSON.stringify({ errors, network }).includes('must-not-appear'));
    observer.detach();
    page.emit('requestfailed', request);
    assert.equal(errors.length, 1);
});

test('an uncorrelated failure has no invented response and pages have distinct identities', () => {
    const one = new EventEmitter(), two = new EventEmitter();
    const errors = [], network = [];
    const observer = observeLiveSkillsBrowser({ errors, network });
    observer.observe(one); observer.observe(two);
    const request = { url: () => 'https://example.test/roboTeamAgent/mcp', method: () => 'GET', failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }) };
    two.emit('requestfailed', request);
    one.emit('console', { type: () => 'error', text: () => 'gateway failed' });
    assert.equal(errors[0].pageId, 'page-2');
    assert.equal(errors[0].responseStatus, undefined);
    assert.equal(errors[1].pageId, 'page-1');
    assert.equal(errors[1].message, 'gateway failed');
});

test('text diagnostics remove structured credentials and credentials in captured UI text', () => {
    const text = liveSkillsDiagnosticText({ sessionId: 'private-session', cookie: 'private-cookie',
        failureUI: { text: 'password=private-password\nAuthorization: Bearer private-token\nphase original' } });
    for (const value of ['private-session', 'private-cookie', 'private-password', 'private-token']) assert.ok(!text.includes(value));
    assert.match(text, /phase original/);
});

function captureFixture() {
    const order = [];
    const evidence = { currentPhase: { label: 'original', stage: 'persisted native completion' }, phases: [],
        lastRuntime: { session: { messages: [{ status: 'pending' }] } } };
    const error = new Error('original: one completed persisted native turn within 150 seconds');
    const collector = createReleaseGateFailureCollector({ env: {} });
    const input = { error, evidence, collector,
        captureRuntime: async () => { order.push('runtime'); return { session: { messages: [{ status: 'pending' }], skillExecution: { active: true } } }; },
        copilot: { isClosed: () => false,
            evaluate: async () => { order.push('ui'); return { text: 'approval pending', controls: [{ id: 'cancel', hidden: false }] }; },
            screenshot: async options => { order.push('screenshot'); assert.match(options.style, /color: transparent/); return Buffer.from('fixture'); } },
        testInfo: { attach: async name => { order.push(`attach:${name}`); } } };
    return { input, order };
}

test('the failed phase, pending runtime and popup evidence are captured before cancellation and close', async () => {
    const { input, order } = captureFixture();
    await captureLiveSkillsFailure(input);
    order.push('cancel', 'close', 'delete');
    assert.deepEqual(order, ['runtime', 'ui', 'screenshot', 'attach:copilot-live-skills-failure-layout.png', 'cancel', 'close', 'delete']);
    assert.equal(input.evidence.failureRuntime.session.skillExecution.active, true);
    assert.equal(input.evidence.primaryFailure.phase.label, 'original');
    assert.equal(input.evidence.failureUI.text, 'approval pending');
    assert.equal(input.collector.failures.length, 0);
});

test('a failed runtime read retains the last snapshot and still captures the popup', async () => {
    const { input, order } = captureFixture();
    input.captureRuntime = async () => { throw new Error('runtime is unavailable'); };
    await captureLiveSkillsFailure(input);
    assert.equal(input.evidence.lastRuntime.session.messages[0].status, 'pending');
    assert.equal(input.evidence.failureRuntime, undefined);
    assert.ok(order.includes('screenshot'));
    assert.throws(() => input.collector.throwIfAny({ primaryError: input.error }), error => {
        assert.equal(error.errors.length, 2);
        assert.match(error.errors[0].message, /within 150 seconds/);
        assert.match(error.errors[1].message, /runtime is unavailable/);
        return true;
    });
});

test('screenshot, browser, cleanup and attachment failures cannot mask the primary timeout', async () => {
    const { input } = captureFixture();
    input.copilot.screenshot = async () => { throw new Error('screenshot failed'); };
    await captureLiveSkillsFailure(input);
    input.collector.add('browser', new Error('net::ERR_CONNECTION_RESET'));
    input.collector.add('cleanup', new Error('native cancellation failed'));
    await input.collector.required('attachment', async () => { throw new Error('attachment failed'); });
    assert.throws(() => input.collector.throwIfAny({ primaryError: input.error }), error => {
        assert.equal(error.errors.length, 5);
        assert.match(error.errors[0].message, /within 150 seconds/);
        for (const message of ['screenshot failed', 'net::ERR_CONNECTION_RESET', 'native cancellation failed', 'attachment failed']) assert.match(error.message, new RegExp(message));
        return true;
    });
    assert.equal(input.evidence.failureRuntime.session.skillExecution.active, true);
    assert.ok(input.evidence.failureUI);
});

test('missing popup diagnostics are explicit failures rather than silently skipped evidence', async () => {
    const { input } = captureFixture();
    input.copilot.isClosed = () => true;
    await captureLiveSkillsFailure(input);
    assert.equal(input.collector.failures.length, 2);
    assert.match(input.collector.failures[0].message, /already closed/);
});
