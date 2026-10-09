import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { collectSecrets } from './security.mjs';

const execFileAsync = promisify(execFile);
const SENSITIVE_FIELD_NAME = String.raw`(?:authorization|(?:[a-z0-9_-]*cookie)|proxy-authorization|password|passphrase|username|credential|credentials|session[-_]?id|csrf(?:token)?|(?:[a-z0-9_-]*token)|(?:[a-z0-9_-]*secret)|(?:[a-z0-9_-]*assertion)|(?:[a-z0-9_-]*api[-_]?key)|private[-_]?key|signing[-_]?key)`;
const SENSITIVE_HEADER_NAME = String.raw`(?:authorization|cookie|set-cookie|proxy-authorization|mcp-session-id|ploinky-agent-assertion|x-ploinky-session-id|x-ploinky-[a-z0-9_-]*(?:token|secret|assertion|key)|ploinky_(?:guest(?:_[a-z0-9_-]+)?|jwt|sso|csrf))`;
const SENSITIVE_FORM_FIELD_NAME = String.raw`(?:password|passphrase|username|credential|credentials|session[-_]?id|csrf(?:token)?|(?:[a-z0-9_-]*token)|(?:[a-z0-9_-]*secret)|(?:[a-z0-9_-]*assertion)|(?:[a-z0-9_-]*api[-_]?key)|private[-_]?key|signing[-_]?key)`;
const SENSITIVE_FIELD_EXPRESSION = new RegExp(`^${SENSITIVE_FIELD_NAME}$`, 'i');
const SENSITIVE_HEADER_EXPRESSION = new RegExp(`^${SENSITIVE_HEADER_NAME}$`, 'i');
const JWT_EXPRESSION = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const PLAYWRIGHT_INPUT_ACTION_FIELDS = new Map([
  ['fill', ['value', 'text']],
  ['type', ['text', 'value']],
  ['presssequentially', ['text', 'value']],
  ['inserttext', ['text', 'value']],
]);

function formAssignmentExpression(flags = 'gim') {
  // A sensitive form/query key must start at a real parameter boundary. In
  // particular, this must never begin inside a header name such as
  // x-ploinky-csrf-token and consume bytes through a later unrelated `v=`.
  return new RegExp(
    `(^|[?&;\\s"'\\\\])(${SENSITIVE_FORM_FIELD_NAME}=)([^&;\\s"'\\\\]*)`,
    flags,
  );
}

function isSensitiveFieldName(name) {
  return SENSITIVE_FIELD_EXPRESSION.test(String(name || ''));
}

function isSensitiveHeaderName(name) {
  return SENSITIVE_HEADER_EXPRESSION.test(String(name || ''));
}

function isRedactionMarker(value) {
  return typeof value === 'string' && value.startsWith('[REDACTED:');
}

function playwrightInputActionFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'before') return [];
  return PLAYWRIGHT_INPUT_ACTION_FIELDS.get(String(value.method || '').toLowerCase()) || [];
}

function literalVariants(values) {
  const variants = new Set();
  for (const rawValue of values || []) {
    if (typeof rawValue !== 'string' || !rawValue || isRedactionMarker(rawValue)) continue;
    variants.add(rawValue);
    try {
      variants.add(encodeURIComponent(rawValue));
    } catch {
      // An unpaired surrogate is still removed in its literal form. It cannot
      // have a valid percent-encoded representation.
    }
  }
  return [...variants].filter(Boolean).sort((left, right) => right.length - left.length);
}

function redactInputActionCopies(input, variants) {
  let output = String(input);
  for (const variant of variants) {
    output = output.split(variant).join('[REDACTED:INPUT]');
  }
  return output;
}

function redactLexicalPayload(input) {
  return String(input)
    .replace(
      new RegExp(`(^[ \\t]*(?:\\x1b\\[[0-9;]*m[ \\t]*)*(?:[-<>][ \\t]*)?)(${SENSITIVE_HEADER_NAME})([ \\t]*:[ \\t]*)([^\\r\\n]+)`, 'gim'),
      (_match, prefix, name, separator, value) => `${prefix}${name}${separator}[REDACTED:HEADER]${(value.match(/\x1b\[[0-9;]*m/g) || []).join('')}`,
    )
    .replace(
      formAssignmentExpression(),
      (_match, boundary, assignment) => `${boundary}${assignment}[REDACTED:FORM]`,
    )
    // Compact JWTs can occur in cookies, WebSocket payloads, or response
    // resources without a nearby field name. They are always credentials in
    // this suite and never useful in a diagnostic artifact.
    .replace(JWT_EXPRESSION, '[REDACTED:JWT]');
}

function parseEmbeddedJson(value) {
  const trimmed = String(value).trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function redactStringValue(value, inputActionVariants) {
  const valueWithoutInputCopies = redactInputActionCopies(value, inputActionVariants);
  const embedded = parseEmbeddedJson(valueWithoutInputCopies);
  if (embedded !== null) {
    const leading = valueWithoutInputCopies.slice(0, valueWithoutInputCopies.indexOf(valueWithoutInputCopies.trimStart()));
    const trailing = valueWithoutInputCopies.slice(valueWithoutInputCopies.trimEnd().length);
    return `${leading}${JSON.stringify(redactStructuredValue(embedded, '', inputActionVariants))}${trailing}`;
  }
  return redactLexicalPayload(valueWithoutInputCopies);
}

function redactStructuredValue(value, containerKey = '', inputActionVariants = []) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactStructuredValue(entry, containerKey, inputActionVariants));
  }
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? redactStringValue(value, inputActionVariants) : value;
  }

  const declaredName = typeof value.name === 'string' ? value.name : '';
  const inputActionFields = playwrightInputActionFields(value);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (isSensitiveFieldName(normalizedKey)) {
      result[key] = '[REDACTED:FIELD]';
      continue;
    }
    if (
      normalizedKey === 'value'
      && (
        containerKey === 'cookies'
        || isSensitiveHeaderName(declaredName)
        || isSensitiveFieldName(declaredName)
      )
    ) {
      result[key] = '[REDACTED:HEADER]';
      continue;
    }
    result[key] = redactStructuredValue(entry, normalizedKey, inputActionVariants);
  }
  if (inputActionFields.length && result.params && typeof result.params === 'object' && !Array.isArray(result.params)) {
    for (const field of inputActionFields) {
      const original = value.params?.[field];
      if (original !== undefined && original !== null && original !== '') {
        result.params[field] = '[REDACTED:INPUT]';
      }
    }
  }
  return result;
}

function parseJsonRecords(text) {
  try {
    return { kind: 'document', values: [JSON.parse(text)] };
  } catch {
    // Playwright trace.trace and trace.network are newline-delimited JSON.
  }

  const lines = text.split(/\r?\n/);
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try {
      records.push({ index, kind: 'json', value: JSON.parse(lines[index]) });
    } catch {
      records.push({ index, kind: 'text', value: lines[index] });
    }
  }
  return records.length > 0 ? { kind: 'lines', lines, records } : null;
}

function redactParsedRecords(parsed, inputActionVariants = []) {
  if (parsed.kind === 'document') {
    return JSON.stringify(redactStructuredValue(parsed.values[0], '', inputActionVariants));
  }
  const redactedLines = [...parsed.lines];
  for (const { index, kind, value } of parsed.records) {
    redactedLines[index] = kind === 'json'
      ? JSON.stringify(redactStructuredValue(value, '', inputActionVariants))
      : redactLexicalPayload(redactInputActionCopies(value, inputActionVariants));
  }
  return redactedLines.join('\n');
}

function collectPlaywrightInputActionValues(value, discovered) {
  if (Array.isArray(value)) {
    for (const entry of value) collectPlaywrightInputActionValues(entry, discovered);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const fields = playwrightInputActionFields(value);
  if (fields.length && value.params && typeof value.params === 'object' && !Array.isArray(value.params)) {
    for (const field of fields) {
      const inputValue = value.params[field];
      if (typeof inputValue === 'string' && inputValue && !isRedactionMarker(inputValue)) {
        discovered.add(inputValue);
      }
    }
  }
  for (const entry of Object.values(value)) collectPlaywrightInputActionValues(entry, discovered);
}

function findInputActionValueCopyInStructuredValue(value, variants, location = '$') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const finding = findInputActionValueCopyInStructuredValue(value[index], variants, `${location}[${index}]`);
      if (finding) return finding;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      const finding = findInputActionValueCopyInStructuredValue(entry, variants, `${location}.${key}`);
      if (finding) return finding;
    }
    return '';
  }
  if (typeof value !== 'string') return '';
  const withoutMarkers = value.replace(/\[REDACTED:[^\]]+\]/g, '');
  return variants.some((variant) => withoutMarkers.includes(variant)) ? location : '';
}

function findInputActionValueCopy(input, variants) {
  const parsed = parseJsonRecords(String(input));
  if (parsed?.kind === 'document') {
    return findInputActionValueCopyInStructuredValue(parsed.values[0], variants);
  }
  if (parsed?.kind === 'lines') {
    for (const { index, kind, value } of parsed.records) {
      const finding = kind === 'json'
        ? findInputActionValueCopyInStructuredValue(value, variants, `$line${index + 1}`)
        : (variants.some((variant) => String(value).replace(/\[REDACTED:[^\]]+\]/g, '').includes(variant))
            ? `$line${index + 1}`
            : '');
      if (finding) return finding;
    }
  }
  return '';
}

export function discoverPlaywrightInputActionValues(input) {
  const discovered = new Set();
  const parsed = parseJsonRecords(String(input));
  if (parsed?.kind === 'document') {
    collectPlaywrightInputActionValues(parsed.values[0], discovered);
  } else if (parsed?.kind === 'lines') {
    for (const record of parsed.records) {
      if (record.kind === 'json') collectPlaywrightInputActionValues(record.value, discovered);
    }
  }
  return Object.freeze([...discovered]);
}

function inspectStringResidue(value, location, findings) {
  const embedded = parseEmbeddedJson(value);
  if (embedded !== null) {
    inspectStructuredResidue(embedded, '', `${location}.embedded`, findings);
    return;
  }
  if (JWT_EXPRESSION.test(value)) findings.push(`${location}:compact-jwt`);
  JWT_EXPRESSION.lastIndex = 0;
  const formMatch = formAssignmentExpression('im').exec(value);
  if (formMatch && !isRedactionMarker(formMatch[3])) {
    findings.push(`${location}:sensitive-form-field`);
  }
}

function inspectStructuredResidue(value, containerKey, location, findings) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      inspectStructuredResidue(entry, containerKey, `${location}[${index}]`, findings);
    });
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') inspectStringResidue(value, location, findings);
    return;
  }

  const declaredName = typeof value.name === 'string' ? value.name : '';
  const inputActionFields = playwrightInputActionFields(value);
  if (inputActionFields.length && value.params && typeof value.params === 'object' && !Array.isArray(value.params)) {
    for (const field of inputActionFields) {
      const inputValue = value.params[field];
      if (inputValue !== undefined && inputValue !== null && inputValue !== '' && !isRedactionMarker(inputValue)) {
        findings.push(`${location}.params.${field}:playwright-input-action`);
      }
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (isSensitiveFieldName(normalizedKey)) {
      if (entry !== '' && entry !== null && !isRedactionMarker(entry)) {
        findings.push(`${location}.${key}:sensitive-field`);
      }
      continue;
    }
    if (
      normalizedKey === 'value'
      && (
        containerKey === 'cookies'
        || isSensitiveHeaderName(declaredName)
        || isSensitiveFieldName(declaredName)
      )
    ) {
      if (entry !== '' && entry !== null && !isRedactionMarker(entry)) {
        findings.push(`${location}.${key}:sensitive-header-or-cookie`);
      }
      continue;
    }
    inspectStructuredResidue(entry, normalizedKey, `${location}.${key}`, findings);
  }
}

export function findTraceCredentialResidue(input) {
  const findings = [];
  const parsed = parseJsonRecords(String(input));
  if (parsed?.kind === 'document') {
    inspectStructuredResidue(parsed.values[0], '', '$', findings);
  } else if (parsed?.kind === 'lines') {
    for (const { index, kind, value } of parsed.records) {
      if (kind === 'json') {
        inspectStructuredResidue(value, '', `$line${index + 1}`, findings);
      } else {
        inspectStringResidue(value, `$line${index + 1}`, findings);
      }
    }
  } else {
    inspectStringResidue(String(input), '$text', findings);
  }
  return findings;
}

async function filesUnder(root) {
  const result = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(target));
    else if (entry.isFile()) result.push(target);
  }
  return result;
}

export function redactTraceText(input, { inputActionValues = [] } = {}) {
  let text = String(input);
  for (const { name, value } of collectSecrets()) {
    for (const variant of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]) {
      if (variant.length >= 6) text = text.split(variant).join(`[REDACTED:${name}]`);
    }
  }

  const parsed = parseJsonRecords(text);
  const inputActionVariants = literalVariants(inputActionValues);
  return parsed
    ? redactParsedRecords(parsed, inputActionVariants)
    : redactLexicalPayload(redactInputActionCopies(text, inputActionVariants));
}

export async function stopAndAttachRedactedTrace(context, testInfo, label) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-trace-'));
  const rawPath = path.join(tempRoot, 'raw.zip');
  const unpacked = path.join(tempRoot, 'unpacked');
  const sanitizedPath = testInfo.outputPath(`${label}.trace.zip`);
  try {
    await context.tracing.stop({ path: rawPath });
    await fs.mkdir(unpacked);
    await execFileAsync('/usr/bin/unzip', ['-q', rawPath, '-d', unpacked]);
    const traceFiles = await filesUnder(unpacked);
    const textualMembers = [];
    const inputActionValues = new Set();
    for (const file of traceFiles) {
      const buffer = await fs.readFile(file);
      if (buffer.includes(0)) continue;
      const original = buffer.toString('utf8');
      textualMembers.push({ file, original });
      for (const value of discoverPlaywrightInputActionValues(original)) inputActionValues.add(value);
    }
    for (const { file, original } of textualMembers) {
      const redacted = redactTraceText(original, { inputActionValues });
      if (redacted !== original) await fs.writeFile(file, redacted);
    }
    const inputActionVariants = literalVariants(inputActionValues);
    for (const file of traceFiles) {
      const buffer = await fs.readFile(file);
      for (const { name, value } of collectSecrets()) {
        if (value.length >= 8 && buffer.includes(Buffer.from(value))) {
          throw new Error(`Secret ${name} remained in ${label} trace.`);
        }
      }
      if (!buffer.includes(0)) {
        const text = buffer.toString('utf8');
        const inputCopy = findInputActionValueCopy(text, inputActionVariants);
        if (inputCopy) {
          throw new Error(`A Playwright input-action value remained in ${label} trace member ${path.basename(file)} at ${inputCopy}.`);
        }
        const residue = findTraceCredentialResidue(text);
        if (residue.length > 0) {
          throw new Error(`Credential-shaped data remained in ${label} trace at ${residue[0]}.`);
        }
      }
    }
    await execFileAsync('/usr/bin/zip', ['-q', '-r', sanitizedPath, '.'], { cwd: unpacked });
    await testInfo.attach(`${label}-redacted-trace`, {
      path: sanitizedPath,
      contentType: 'application/zip',
    });
    return sanitizedPath;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
