import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadinessDiagnostics, withFailureArtifact } from './readiness-diagnostics.mjs';
import { createCopilotDiagnostics } from './copilot-terminal-diagnostics.mjs';

const runtime = id => ({ agents: [{ agentName: 'gitAgent', containerId: id, instanceId: 'instance', enableGeneration: 'generation', projectedTarget: null }] });

test('failed collection, workspace binding and eligibility keep the actual last cause and fail', async () => {
    for (const [stage, message] of [['collection', 'collector unavailable'], ['workspace-binding', 'workspace bind mount mismatch'], ['eligibility', 'gitAgent must be eligible for the selected folder.']]) {
        const diagnostics = createReadinessDiagnostics({ now: () => 'timestamp' });
        const ready = diagnostics.sample(() => { if (stage !== 'eligibility') throw new Error(message); return runtime('a'); }, () => { throw new Error(message); });
        assert.equal(ready, false);
        assert.deepEqual(diagnostics.evidence.lastFailure, { at: 'timestamp', stage, message });
        const primary = new Error('original readiness assertion failed');
        let attached;
        await assert.rejects(withFailureArtifact(async () => { throw primary; }, async body => { attached = JSON.parse(body); }, diagnostics.evidence), error => error === primary);
        assert.equal(attached.lastFailure.message, message);
    }
});

test('definitively stale generation stops on the first collection and keeps its original error', async () => {
    const state = createReadinessDiagnostics();
    const error = new Error('Box outer container generation is not fresh enough for the release gate.');
    let calls = 0, artifact;
    await assert.rejects(withFailureArtifact(async () => {
        state.sample(() => { calls += 1; throw error; }, () => {});
    }, async body => { artifact = JSON.parse(body); }, state.evidence), value => value === error);
    assert.equal(calls, 1);
    assert.equal(artifact.lastFailure.message, error.message);
});

test('changing runtime identities, intermittent collector failures and missing samples never satisfy stability', () => {
    const state = createReadinessDiagnostics();
    for (let index = 0; index < 20; index += 1) assert.equal(state.sample(() => runtime(String(index)), () => {}), false);
    assert.equal(state.evidence.samples.length, 12);
    assert.equal(state.evidence.lastFailure.stage, 'unstable-signatures');
    assert.equal(state.sample(() => runtime('steady'), () => {}), false);
    assert.equal(state.sample(() => runtime('steady'), () => {}), false);
    assert.equal(state.sample(() => { throw new Error('collector failed'); }, () => {}), false);
    assert.equal(state.sample(() => runtime('steady'), () => {}), false);
    assert.equal(state.sample(() => runtime('steady'), () => {}), false);
    assert.equal(state.sample(() => runtime('steady'), () => {}), true);
    assert.equal(state.evidence.lastFailure, null);
    const noSamples = createReadinessDiagnostics();
    assert.equal(noSamples.evidence.stableSamples, 0);
    assert.equal(noSamples.evidence.lastFailure.stage, 'missing-stable-samples');
});

test('Playwright polling propagates stale collection failure immediately instead of retrying it', async () => {
    const { expect } = await import('@playwright/test');
    const state = createReadinessDiagnostics();
    let calls = 0;
    await assert.rejects(expect.poll(() => state.sample(() => {
        calls += 1; throw new Error('Box outer container generation is not fresh enough for the release gate.');
    }, () => {}), { timeout: 1000, intervals: [1] }).toBe(true), /not fresh enough/);
    assert.equal(calls, 1);
});

test('artifact write failure is visible, preserves primary failure, and cannot turn success green', async () => {
    const original = new Error('original failed assertion');
    const logs = [];
    await assert.rejects(withFailureArtifact(async () => { throw original; }, async () => { throw new Error('disk full'); }, {}, { report: text => logs.push(text) }), error => error === original);
    assert.equal(original.artifactFailure, 'disk full');
    assert.match(logs[0], /disk full/);
    await assert.rejects(withFailureArtifact(async () => true, async () => { throw new Error('disk full'); }, {}), /disk full/);
});

test('Copilot preserves first visible terminal error/time and rejects an error bubble as a reply', () => {
    let timestamp = 'first';
    const state = createCopilotDiagnostics({ now: () => timestamp });
    state.submitted();
    assert.throws(() => state.observe(['[input error] Marketplace recovery required']), /terminal.*failed/);
    timestamp = 'later';
    assert.throws(() => state.observe(['[error] later provider failure']));
    assert.deepEqual(state.evidence.firstTerminalError, { at: 'first', message: '[input error] Marketplace recovery required' });
    assert.equal(state.evidence.replyOutcome, 'terminal-error');
    assert.equal(state.evidence.submissions.length, 1);
    const valid = createCopilotDiagnostics();
    valid.observe(['Hello']); valid.submitted(); valid.observe(['COPILOT_CHAT_OK']); valid.replied();
    assert.equal(valid.evidence.replyOutcome, 'assistant-reply');
});

test('diagnostic payloads redact fabricated secrets before attachment or error messages', async () => {
    const previous = process.env.SMOKE_PASSWORD;
    process.env.SMOKE_PASSWORD = 'fabricated-private-secret';
    try {
        const state = createCopilotDiagnostics();
        assert.throws(() => state.observe(['[input error] fabricated-private-secret']), error => !error.message.includes(process.env.SMOKE_PASSWORD));
        const readiness = createReadinessDiagnostics();
        readiness.sample(() => { throw new Error('collector fabricated-private-secret'); }, () => {});
        let text;
        await withFailureArtifact(async () => false, async body => { text = body.toString(); }, readiness.evidence);
        assert.doesNotMatch(text, /fabricated-private-secret/);
    } finally { if (previous === undefined) delete process.env.SMOKE_PASSWORD; else process.env.SMOKE_PASSWORD = previous; }
});
