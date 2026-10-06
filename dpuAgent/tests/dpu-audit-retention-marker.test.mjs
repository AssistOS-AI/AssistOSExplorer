import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const storageUrl = new URL('../lib/dpu-store-internal/storage.mjs', import.meta.url);
const { appendAuditLine, pruneExpiredAuditFiles } = await import(`${storageUrl.href}?retention-marker=${Date.now()}`);

const previousDataRoot = process.env.DPU_DATA_ROOT;
const DAY_ONE = new Date('2100-06-16T10:00:00.000Z');
const DAY_TWO = new Date('2100-06-17T10:00:00.000Z');
const EXPIRED = '2099-01-01.jsonl';
const RECENT = '2100-06-15.jsonl';

function createRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpu-retention-marker-'));
  process.env.DPU_DATA_ROOT = root;
  const auditRoot = path.join(root, 'audit');
  fs.mkdirSync(auditRoot, { recursive: true });
  return { root, auditRoot, marker: path.join(auditRoot, '.retention-day') };
}

function plantFiles(auditRoot) {
  fs.writeFileSync(path.join(auditRoot, EXPIRED), '{}\n');
  fs.writeFileSync(path.join(auditRoot, RECENT), '{}\n');
}

function runChildPrune(root, isoNow) {
  const script = `
    const { pruneExpiredAuditFiles } = await import(${JSON.stringify(storageUrl.href)});
    await pruneExpiredAuditFiles(new Date(${JSON.stringify(isoNow)}));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, DPU_DATA_ROOT: root },
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function captureWarnings() {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  return { warnings, restore() { console.warn = original; } };
}

test.after(() => {
  if (previousDataRoot === undefined) delete process.env.DPU_DATA_ROOT;
  else process.env.DPU_DATA_ROOT = previousDataRoot;
});

test('a successful prune persists the retention day and appendAuditLine writes it on first use', async () => {
  const { auditRoot, marker } = createRoot();
  plantFiles(auditRoot);
  await pruneExpiredAuditFiles(DAY_ONE);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), '2100-06-16');
  assert.equal(fs.existsSync(path.join(auditRoot, EXPIRED)), false);

  const fresh = createRoot();
  const before = new Date().toISOString().slice(0, 10);
  await appendAuditLine('2100-06-16.jsonl', '{"event":"first"}');
  const after = new Date().toISOString().slice(0, 10);
  assert.ok([before, after].includes(fs.readFileSync(fresh.marker, 'utf8').trim()));
  assert.deepEqual(fs.readdirSync(fresh.auditRoot).filter((name) => name.endsWith('.tmp')), []);
});

test('a second process on the same day skips retention and a new day prunes again', async () => {
  const { root, auditRoot, marker } = createRoot();
  await pruneExpiredAuditFiles(DAY_ONE);
  plantFiles(auditRoot);

  runChildPrune(root, DAY_ONE.toISOString());
  assert.equal(fs.existsSync(path.join(auditRoot, EXPIRED)), true, 'same-day child must leave the planted expired file');

  runChildPrune(root, DAY_TWO.toISOString());
  assert.equal(fs.existsSync(path.join(auditRoot, EXPIRED)), false);
  assert.equal(fs.existsSync(path.join(auditRoot, RECENT)), true);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), '2100-06-17');
});

test('a corrupt retention marker is treated as absent', async () => {
  const { auditRoot, marker } = createRoot();
  plantFiles(auditRoot);
  fs.writeFileSync(marker, Buffer.from([0xff, 0xfe, 0x00, 0x42, 0x7b]));
  await pruneExpiredAuditFiles(DAY_ONE);
  assert.equal(fs.existsSync(path.join(auditRoot, EXPIRED)), false);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), '2100-06-16');
});

test('an unreadable or unwritable marker is logged and never fails appendAuditLine', async () => {
  const { auditRoot, marker } = createRoot();
  plantFiles(auditRoot);
  // A directory at the marker path makes both the read and the rename fail.
  fs.mkdirSync(marker);
  const captured = captureWarnings();
  try {
    await pruneExpiredAuditFiles(DAY_ONE);
    await appendAuditLine('2100-06-16.jsonl', '{"event":"still appended"}');
  } finally {
    captured.restore();
  }
  assert.equal(fs.existsSync(path.join(auditRoot, EXPIRED)), false, 'retention still ran');
  assert.match(fs.readFileSync(path.join(auditRoot, '2100-06-16.jsonl'), 'utf8'), /still appended/);
  assert.ok(captured.warnings.some((message) => message.includes('audit retention marker')), captured.warnings.join('\n'));
  assert.equal(fs.statSync(marker).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(auditRoot).filter((name) => name.endsWith('.tmp')), []);
});

test('concurrent writers never collide on a temporary name and leave one valid marker', async () => {
  const { root, auditRoot, marker } = createRoot();
  const captured = captureWarnings();
  try {
    // Several in-process prunes pass the in-memory check together; child processes add cross-process writers.
    await Promise.all(Array.from({ length: 12 }, () => pruneExpiredAuditFiles(DAY_ONE)));
  } finally {
    captured.restore();
  }
  assert.deepEqual(captured.warnings, []);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), '2100-06-16');

  fs.rmSync(marker);
  const children = Array.from({ length: 6 }, () => new Promise((resolve) => {
    const script = `
      const { pruneExpiredAuditFiles } = await import(${JSON.stringify(storageUrl.href)});
      await Promise.all(Array.from({ length: 4 }, () => pruneExpiredAuditFiles(new Date(${JSON.stringify(DAY_ONE.toISOString())}))));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, DPU_DATA_ROOT: root } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stderr }));
  }));
  for (const child of await Promise.all(children)) {
    assert.equal(child.status, 0, child.stderr);
    assert.doesNotMatch(child.stderr, /audit retention marker/);
  }
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), '2100-06-16');
  assert.deepEqual(fs.readdirSync(auditRoot).filter((name) => name.endsWith('.tmp')), []);
});
