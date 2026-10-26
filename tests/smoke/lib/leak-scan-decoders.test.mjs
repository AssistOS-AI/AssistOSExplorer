import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { test } from 'node:test';

import {
  EMBEDDED_ZIP_PREFIX, LeakScanDecodeError, base64Needles, decodeBase64Strict, embeddedZipEntries, embeddedZipPayloads, readZipEntries, secretNeedles,
} from './leak-scan-decoders.mjs';

// The fixtures in fixtures/leak-scan/ are real Playwright 1.60.0 output (Chromium headless shell 1223, macOS arm64), generated once on
// 2026-10-26 by a throwaway spec that was deleted afterwards:
//   node node_modules/playwright/cli.js test -c leakgen.config.mjs   (HOME=<empty temporary directory>)
// leakgen.config.mjs: testMatch 'leakgen.spec.mjs', retries 0, workers 1, reporters html (open never) and json, trace, video and
// screenshot off. leakgen.spec.mjs opened about:blank and attached one body:
//   testInfo.attach('copilot-live-skills-evidence.json', { body: Buffer.from(JSON.stringify({ kind: 'leak-scan-fixture', evidence: FIXTURE_TOKEN })),
//     contentType: 'application/json' })
// where FIXTURE_TOKEN is the fabricated, unsigned JWT-shaped string below. It is not, and never was, a credential.
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const FIXTURE_TOKEN = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ exp: 1924992000, sub: 'leak-scan-fixture-not-a-credential' })}.`;
const FIXTURES = new URL('./fixtures/leak-scan/', import.meta.url);
const html = () => fs.readFileSync(new URL('index.html', FIXTURES), 'utf8');

const includesAny = (text, needles) => needles.some((needle) => text.includes(needle));

test('base64 needles match the secret at every byte alignment and never depend on the surrounding bytes', () => {
  const secret = 'access-token-value-0123456789';
  const needles = base64Needles(secret);
  const urlNeedles = base64Needles(secret, { url: true });
  assert.equal(needles.length, 3);
  for (const before of ['', 'a', 'ab', 'abc', 'ÿþ']) {
    for (const after of ['', 'z', 'zz', 'zzz']) {
      const bytes = Buffer.concat([Buffer.from(before, 'latin1'), Buffer.from(secret), Buffer.from(after)]);
      assert.ok(includesAny(bytes.toString('base64'), needles), `base64 with ${before.length} bytes before`);
      assert.ok(includesAny(bytes.toString('base64url'), urlNeedles), `base64url with ${before.length} bytes before`);
    }
  }
  // Negative controls: a one-character change of the secret, and the other alphabet, are not matched.
  const changed = Buffer.from(`x${secret.slice(0, 10)}Y${secret.slice(11)}`).toString('base64');
  assert.equal(includesAny(changed, needles.filter((needle) => needle.length > 20)), false);
  const plusSecret = '>>>?>>>?>>>?>>>?';
  assert.equal(includesAny(Buffer.from(plusSecret).toString('base64'), base64Needles(plusSecret, { url: true })), false);
  assert.ok(secretNeedles(secret).includes(secret));
});

test('the real Playwright HTML report embeds one deflated zip whose entries carry the attachment, and the raw text does not', () => {
  const text = html();
  assert.equal(text.includes(FIXTURE_TOKEN), false);
  const payloads = embeddedZipPayloads(text);
  assert.equal(payloads.length, 1);
  const entries = embeddedZipEntries(text);
  assert.ok(entries.some((entry) => entry.name === 'report.json'));
  assert.ok(entries.some((entry) => includesAny(entry.data.toString('utf8'), secretNeedles(FIXTURE_TOKEN))), 'an entry carries the attachment');
  // Negative control: another token is not found in the same entries.
  const other = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ exp: 1924992000, sub: 'some-other-fixture' })}.`;
  assert.equal(entries.some((entry) => includesAny(entry.data.toString('utf8'), secretNeedles(other))), false);
});

test('the real results.json carries the attachment body as base64, which only the base64 needles find', () => {
  const text = fs.readFileSync(new URL('results.json', FIXTURES), 'utf8');
  assert.equal(text.includes(FIXTURE_TOKEN), false);
  assert.ok(includesAny(text, base64Needles(FIXTURE_TOKEN)));
});

test('stored and deflated entries decode; truncation, a bad CRC, another method, encryption and an oversized entry are refused', () => {
  const entries = readZipEntries(decodeBase64Strict(embeddedZipPayloads(html())[0]));
  assert.ok(entries.length >= 2);
  const zipped = decodeBase64Strict(embeddedZipPayloads(html())[0]);
  const reason = (work) => { try { work(); } catch (error) { assert.ok(error instanceof LeakScanDecodeError); return error.reason; } return null; };
  assert.equal(reason(() => readZipEntries(zipped.subarray(0, Math.floor(zipped.length / 2)))), 'zip-truncated');
  assert.equal(reason(() => readZipEntries(Buffer.alloc(10))), 'zip-truncated');
  // A one-entry stored archive, then its corruptions.
  const stored = storedZip('a.txt', Buffer.from('hello stored entry'));
  assert.deepEqual(readZipEntries(stored).map((entry) => [entry.name, entry.data.toString()]), [['a.txt', 'hello stored entry']]);
  const badCrc = Buffer.from(stored); badCrc.writeUInt32LE(0, stored.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 16);
  assert.equal(reason(() => readZipEntries(badCrc)), 'zip-crc');
  const otherMethod = Buffer.from(stored); otherMethod.writeUInt16LE(12, stored.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
  assert.equal(reason(() => readZipEntries(otherMethod)), 'zip-method');
  const encrypted = Buffer.from(stored); encrypted.writeUInt16LE(1, stored.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
  assert.equal(reason(() => readZipEntries(encrypted)), 'zip-encrypted');
  assert.equal(reason(() => readZipEntries(stored, { entryLimit: 4 })), 'zip-entry-oversize');
  // Non-canonical base64 is refused instead of being decoded leniently.
  for (const bad of ['', 'abc', 'ab$=', 'QQ==QQ==']) assert.equal(reason(() => decodeBase64Strict(bad)), 'base64');
  assert.equal(reason(() => embeddedZipEntries(`<template>${EMBEDDED_ZIP_PREFIX}UEsDBA==</template>`)), 'zip-truncated');
});

// A minimal stored zip with one entry, written byte by byte as the format defines it.
function storedZip(name, data) {
  const nameBytes = Buffer.from(name);
  const crc = zlib.crc32(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
  const centralOffset = local.length + nameBytes.length + data.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12); end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
}
