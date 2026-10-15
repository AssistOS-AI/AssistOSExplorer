import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { projectLiveSessionError, createLiveSessionFinalizer } from './live-sessions-diagnostics.mjs';

test('safe projection preserves nested causes, aggregates and thrown primitives without invoking getters', () => {
    let accessed = false;
    const hostile = Object.defineProperties({}, { message: { get() { accessed = true; throw new Error('getter'); } },
        toString: { value() { accessed = true; throw new Error('stringify'); } } });
    const nested = new AggregateError([new Error('child one'), 'child two', hostile], 'parent');
    nested.cause = nested;
    const result = projectLiveSessionError(nested);
    assert.equal(accessed, false);
    assert.match(JSON.stringify(result), /child one/);
    assert.match(JSON.stringify(result), /child two/);
    assert.match(JSON.stringify(result), /cyclic error reference/);
    assert.match(JSON.stringify(result), /accessor omitted/);
});

test('configured and lexical credentials are redacted before text truncation including boundary fragments', () => {
    const canary = 'boundary-secret-abcdefghijklmnopqrstuvwxyz';
    const error = new Error('x'.repeat(70) + canary + '\nauthorization: Bearer other-private-token');
    const result = JSON.stringify(projectLiveSessionError(error, { env: { FIXTURE_TOKEN: canary }, maxText: 96 }));
    assert.ok(!result.includes(canary));
    assert.ok(!result.includes('boundary-secret'));
    assert.ok(!result.includes('other-private-token'));
    assert.match(result, /truncated/);
    const tree = new AggregateError(Array.from({ length: 1000 }, () => new Error('x'.repeat(10000))), 'many');
    assert.ok(Buffer.byteLength(JSON.stringify(projectLiveSessionError(tree))) < 100000);
});

test('finalization preserves primary and every required failure including attachment failure', async () => {
    const finalizer = createLiveSessionFinalizer({ env: { FIXTURE_SECRET: 'diagnostic-private-canary' } });
    await finalizer.required('terminate owned flow', async () => { throw new AggregateError([new Error('termination child')], 'termination failed'); });
    await finalizer.required('settle owned cwd', async () => { throw 'settlement failed'; });
    await assert.rejects(finalizer.finish({ attach() { throw new Error('attachment failed'); } }, new Error('primary diagnostic-private-canary')), error => {
        for (const text of ['primary failure', 'terminate owned flow', 'termination child', 'settle owned cwd', 'settlement failed', 'safe failure attachment', 'attachment failed']) assert.ok(error.message.includes(text), text);
        assert.ok(!error.message.includes('diagnostic-private-canary'));
        return true;
    });
});

test('a thrown undefined remains a primary failure and success remains success', async () => {
    await createLiveSessionFinalizer().finish({ attach() { assert.fail('success has no failure attachment'); } });
    await assert.rejects(createLiveSessionFinalizer().finish({ attach() {} }, undefined, { hasPrimary: true }), /primary failure.*ThrownValue/);
});

test('actual provider-free Playwright JSON keeps safe primary and cleanup children in candidate summary and attachment', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-diagnostics-'));
    try {
        const module = new URL('./live-sessions-diagnostics.mjs', import.meta.url).href;
        const playwright = new URL('../node_modules/@playwright/test/index.mjs', import.meta.url).href;
        fs.writeFileSync(path.join(root, 'fixture.spec.mjs'), `import { test } from ${JSON.stringify(playwright)};
import { createLiveSessionFinalizer } from ${JSON.stringify(module)};
test('safe diagnostics', async ({}, info) => { const f = createLiveSessionFinalizer({env:{FIXTURE_SECRET:'subprocess-private-canary'}});
f.add('cleanup-one', new Error('detail-one')); f.add('cleanup-two', new Error('detail-two'));
await f.finish(info, new Error('primary-detail subprocess-private-canary')); });`);
        fs.writeFileSync(path.join(root, 'playwright.config.mjs'), `export default {testDir:${JSON.stringify(root)},outputDir:${JSON.stringify(path.join(root, 'results'))},reporter:'json'};`);
        const cli = new URL('../node_modules/@playwright/test/cli.js', import.meta.url);
        const result = spawnSync(process.execPath, [cli.pathname, 'test', '--config', path.join(root, 'playwright.config.mjs')], { encoding: 'utf8', timeout: 30000 });
        assert.equal(result.status, 1, result.stderr);
        const report = JSON.parse(result.stdout), text = JSON.stringify(report);
        for (const detail of ['primary-detail', 'cleanup-one', 'detail-one', 'cleanup-two', 'detail-two']) assert.ok(text.includes(detail), detail);
        assert.ok(!text.includes('subprocess-private-canary'));
        const attachments = report.suites[0].specs[0].tests[0].results[0].attachments;
        const safe = attachments.filter(item => item.name === 'live-session-failures.json');
        assert.equal(safe.length, 1);
        const attachment = Buffer.from(safe[0].body, 'base64').toString();
        assert.match(attachment, /primary-detail/);
        assert.match(attachment, /detail-one/);
        assert.match(attachment, /detail-two/);
        fs.writeFileSync(path.join(root, 'fixture.spec.mjs'), `import { test } from ${JSON.stringify(playwright)};
test('baseline aggregation', async () => {
const children = [['baseline','primary'],['baseline','cleanup','one'],['baseline','cleanup','two']].map(parts => new Error(parts.join('-')));
throw new AggregateError(children, 'Live Sessions cleanup/diagnostics failed; preserve the original failure and all cleanup failures.'); });`);
        const baseline = spawnSync(process.execPath, [cli.pathname, 'test', '--config', path.join(root, 'playwright.config.mjs')], { encoding: 'utf8', timeout: 30000 });
        assert.equal(baseline.status, 1);
        const baselineErrors = JSON.stringify(JSON.parse(baseline.stdout).suites[0].specs[0].tests[0].results[0].errors);
        assert.ok(!baselineErrors.includes('baseline-primary'));
        assert.ok(!baselineErrors.includes('baseline-cleanup-one'));
        assert.ok(!baselineErrors.includes('baseline-cleanup-two'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
