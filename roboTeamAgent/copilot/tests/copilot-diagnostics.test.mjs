import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { errorFields, logDiagnostic, tokenPrefix } from '../src/lib/storage/copilotDiagnostics.mjs';

function workspace(t) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-diag-')));
    const old = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = dir;
    t.after(() => {
        if (old === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = old;
        fs.chmodSync(path.join(dir, '.roboteam'), 0o700);
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}

function quietStderr(t, mirror = true) {
    const lines = [];
    const oldMode = process.env.ROBOTEAM_COPILOT_DIAGNOSTICS;
    if (mirror) process.env.ROBOTEAM_COPILOT_DIAGNOSTICS = 'stderr';
    t.after(() => { if (oldMode === undefined) delete process.env.ROBOTEAM_COPILOT_DIAGNOSTICS; else process.env.ROBOTEAM_COPILOT_DIAGNOSTICS = oldMode; });
    const original = process.stderr.write;
    process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
    t.after(() => { process.stderr.write = original; });
    return lines;
}

test('records go to stderr and a private 0600 JSONL file with the fixed fields', (t) => {
    const dir = workspace(t);
    const stderr = quietStderr(t);
    logDiagnostic(dir, 'unit.event', { lock: 'x.lock', token: tokenPrefix('secret-token') });
    logDiagnostic(dir, 'unit.second');
    const file = path.join(dir, '.roboteam', 'logs', 'copilot-diagnostics.jsonl');
    const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.equal(records[0].event, 'unit.event');
    assert.equal(records[0].pid, process.pid);
    assert.match(records[0].ts, /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.equal(typeof records[0].mono, 'number');
    assert.ok(records[1].mono >= records[0].mono);
    assert.equal(records[0].token, tokenPrefix('secret-token'));
    assert.equal(records[0].token.length, 8);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /secret-token/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(stderr.length, 2);
    assert.equal(JSON.parse(stderr[0]).event, 'unit.event');
});

test('stderr is untouched by default and the file is still written', (t) => {
    const dir = workspace(t);
    const stderr = quietStderr(t, false);
    delete process.env.ROBOTEAM_COPILOT_DIAGNOSTICS;
    logDiagnostic(dir, 'unit.quiet');
    assert.equal(stderr.length, 0);
    assert.equal(fs.readFileSync(path.join(dir, '.roboteam', 'logs', 'copilot-diagnostics.jsonl'), 'utf8').includes('unit.quiet'), true);
    process.env.ROBOTEAM_COPILOT_DIAGNOSTICS = '0';
    assert.equal(logDiagnostic(dir, 'unit.off'), null);
    assert.equal(stderr.length, 0);
});

test('logging never throws when the directory is unwritable or the path is unsafe', (t) => {
    const dir = workspace(t);
    const stderr = quietStderr(t);
    logDiagnostic(dir, 'unit.first');
    // Existing private root becomes unwritable, and the log file becomes a symlink.
    const logs = path.join(dir, '.roboteam', 'logs');
    fs.rmSync(path.join(logs, 'copilot-diagnostics.jsonl'));
    fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(logs, 'copilot-diagnostics.jsonl'));
    assert.doesNotThrow(() => logDiagnostic(dir, 'unit.symlink'));
    assert.equal(fs.existsSync(path.join(dir, 'elsewhere')), false, 'must not follow a symlink');
    assert.doesNotThrow(() => logDiagnostic('/nonexistent/path/for/diagnostics', 'unit.missing'));
    assert.doesNotThrow(() => logDiagnostic(undefined, 'unit.no-dir'));
    assert.doesNotThrow(() => logDiagnostic(dir, 'unit.cycle', (() => { const a = {}; a.a = a; return { a }; })()));
    assert.ok(stderr.length >= 4, 'stderr still receives the records');
    if (process.getuid?.() !== 0) {
        fs.rmSync(path.join(logs, 'copilot-diagnostics.jsonl'));
        fs.chmodSync(logs, 0o500);
        assert.doesNotThrow(() => logDiagnostic(dir, 'unit.readonly'));
        fs.chmodSync(logs, 0o700);
    }
});

test('errorFields keeps code, message and stack, and tokenPrefix never returns the token', () => {
    const fields = errorFields(Object.assign(new Error('boom'), { code: 'E_BOOM' }));
    assert.equal(fields.code, 'E_BOOM');
    assert.equal(fields.message, 'boom');
    assert.match(fields.stack, /boom/);
    assert.equal(tokenPrefix(''), null);
    assert.equal(tokenPrefix('abcdef-0123').includes('abcdef'), false);
});
