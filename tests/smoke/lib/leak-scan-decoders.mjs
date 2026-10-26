import zlib from 'node:zlib';

// Decoders for the credential leak scan (lib/codex-test-auth.mjs `scanLeaks`). Plain substring matching misses a secret that an
// artifact carries encoded: Playwright's JSON reporter stores attachment bodies as base64, and its HTML report embeds the whole report,
// attachments included, as a deflated zip in base64. This module only builds search needles and decodes containers. It never logs or
// returns a secret value, and nothing here touches the file system or the network.

export const EMBEDDED_ZIP_PREFIX = 'data:application/zip;base64,';
// An entry of an embedded or on-disk zip that inflates beyond this is not scanned, and is reported as undecodable.
export const ZIP_ENTRY_LIMIT = 64 * 1024 * 1024;

export class LeakScanDecodeError extends Error {
  // `reason` is a fixed word; the message never carries data from the artifact.
  constructor(reason) {
    super(`leak-scan decode failed: ${reason}`);
    this.name = 'LeakScanDecodeError';
    this.reason = reason;
  }
}

const undecodable = (reason) => new LeakScanDecodeError(reason);

// The base64 text of `value` as it appears inside any larger base64 text, at each of the three byte alignments. A base64 character
// carries six bits, so the characters at both ends that also depend on the surrounding bytes are trimmed. Every remaining character
// depends on the secret's bytes only, so a match does not depend on what is encoded before or after the secret.
export function base64Needles(value, { url = false } = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const needles = new Set();
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64');
    const first = Math.ceil((8 * offset) / 6);
    const last = Math.floor((8 * (offset + bytes.length)) / 6);
    const needle = encoded.slice(first, last);
    if (needle.length > 0) needles.add(url ? needle.replaceAll('+', '-').replaceAll('/', '_') : needle);
  }
  return [...needles];
}

// Every form one secret is searched in: raw, base64 and base64url at the three alignments.
export function secretNeedles(value) {
  return [...new Set([String(value), ...base64Needles(value), ...base64Needles(value, { url: true })])];
}

// The base64 payloads of every `data:application/zip;base64,` URL in a text (Playwright's HTML report). The payload is the
// longest run of base64 characters after the prefix.
export function embeddedZipPayloads(text) {
  const payloads = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(EMBEDDED_ZIP_PREFIX, from);
    if (at < 0) return payloads;
    const start = at + EMBEDDED_ZIP_PREFIX.length;
    let end = start;
    while (end < text.length && /[A-Za-z0-9+/=]/.test(text[end])) end += 1;
    payloads.push(text.slice(start, end));
    from = end;
  }
}

// Strict base64: Node's decoder skips invalid characters silently, so the text is re-encoded and compared.
export function decodeBase64Strict(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw undecodable('base64');
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text) throw undecodable('base64');
  return bytes;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

// Reads every entry of a zip through its central directory. Supports stored (0) and deflated (8) entries, as Playwright writes them.
// Anything else (encryption, zip64, another method, a size or CRC mismatch, an entry over the limit, a truncated archive) throws, so
// the caller reports the file as undecodable instead of skipping it.
export function readZipEntries(buffer, { entryLimit = ZIP_ENTRY_LIMIT } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw undecodable('zip-truncated');
  let eocd = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 0xffff); at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD) { eocd = at; break; }
  }
  if (eocd < 0) throw undecodable('zip-truncated');
  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  const offset = buffer.readUInt32LE(eocd + 16);
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0 || buffer.readUInt16LE(eocd + 8) !== count) throw undecodable('zip-multidisk');
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw undecodable('zip64');
  if (offset + size > eocd) throw undecodable('zip-truncated');
  const entries = [];
  let at = offset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > eocd || buffer.readUInt32LE(at) !== CENTRAL) throw undecodable('zip-central');
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const uncompressedSize = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    if (at + 46 + nameLength > eocd) throw undecodable('zip-central');
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if ((flags & 0x1) !== 0) throw undecodable('zip-encrypted');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw undecodable('zip64');
    if (uncompressedSize > entryLimit) throw undecodable('zip-entry-oversize');
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL) throw undecodable('zip-local');
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > offset) throw undecodable('zip-truncated');
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: entryLimit }); } catch { throw undecodable('zip-inflate'); }
    } else throw undecodable('zip-method');
    if (data.length !== uncompressedSize || zlib.crc32(data) !== crc) throw undecodable('zip-crc');
    entries.push({ name, data });
  }
  return entries;
}

// The decoded entries of every embedded zip in a text. Throws LeakScanDecodeError when one cannot be decoded.
export function embeddedZipEntries(text, options) {
  return embeddedZipPayloads(text).flatMap((payload) => readZipEntries(decodeBase64Strict(payload), options));
}
