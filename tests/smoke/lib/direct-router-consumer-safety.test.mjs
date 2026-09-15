import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const EXECUTABLE_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.mjs', '.sh', '.ts', '.tsx', '.yaml', '.yml']);
const EXCLUDED_DIRECTORIES = new Set(['.git', 'docs', 'node_modules', 'test', 'tests']);
const SIGNALS = Object.freeze({
  'direct-router-env': /\bPLOINKY_ROUTER_(?:URL|HOST|PORT|AUTHORITY|REQUEST_AUTHORITY)\b/,
  'generated-router-key': /\bPLOINKY_AGENT_API_KEY\b|\bPLOINKY_ENV_SOURCE_[A-Z0-9_]+\b/,
  'verified-router-client': /\bAgentMcpClient\.mjs\b/,
});

const DISPOSITIONS = Object.freeze({
  'gitAgent/lib/secret-store-client.mjs': {
    signals: ['verified-router-client'],
    disposition: 'Delegates transport to the mounted Ploinky AgentMcpClient descriptor verifier.',
  },
  'onlyOffice/src/index.mjs': {
    signals: ['verified-router-client'],
    disposition: 'Loads the mounted Ploinky AgentMcpClient for DPU calls; it owns no Router socket.',
  },
  'userPersistoAgent/lib/email-agent-client.mjs': {
    signals: ['verified-router-client'],
    disposition: 'Delegates authentication-email delivery to the mounted Ploinky AgentMcpClient for emailAgent MCP calls.',
  },
  'userPersistoAgent/manifest.json': {
    signals: ['direct-router-env'],
    disposition: 'Declares optional Router-port metadata for the SSO provider; the manifest opens no transport.',
  },
  'userPersistoAgent/runtime/index.mjs': {
    signals: ['direct-router-env'],
    disposition: 'Runs inside the Router generic SSO bridge and authenticates its provider-service calls with the shared runtime secret.',
  },
  'webmeetAgent/lib/scripta/explorer-crdt-client.mjs': {
    signals: ['verified-router-client'],
    disposition: 'Loads the mounted Ploinky AgentMcpClient for Explorer MCP calls.',
  },
  'webmeetScribeAgent/lib/runtime-config.mjs': {
    signals: ['direct-router-env'],
    disposition: 'Validates the generated Router origin and request authority before the loopback LiveKit relay opens an upstream socket.',
  },
  'webmeetScribeAgent/server/livekit-scribe.mjs': {
    signals: ['verified-router-client'],
    disposition: 'Loads the mounted Ploinky AgentMcpClient for delegated WebMeet MCP calls; it owns no direct Router transport.',
  },
});

function executableFiles(directory, relative = '') {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const childRelative = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...executableFiles(absolute, childRelative));
    else if (entry.isFile() && EXECUTABLE_EXTENSIONS.has(path.extname(entry.name))) files.push(childRelative);
  }
  return files;
}

test('every executable Router consumer has one explicit safe disposition', () => {
  const observed = {};
  for (const relative of executableFiles(REPOSITORY_ROOT)) {
    const source = fs.readFileSync(path.join(REPOSITORY_ROOT, relative), 'utf8');
    const signals = Object.entries(SIGNALS)
      .filter(([, pattern]) => pattern.test(source))
      .map(([name]) => name)
      .sort();
    if (signals.length) observed[relative] = signals;
  }

  assert.deepEqual(
    observed,
    Object.fromEntries(Object.entries(DISPOSITIONS).map(([relative, disposition]) => [
      relative,
      [...disposition.signals].sort(),
    ])),
  );
  for (const disposition of Object.values(DISPOSITIONS)) {
    assert.ok(disposition.disposition.length > 20);
  }
});

test('legacy multimedia and OnlyOffice fallbacks are absent from executable sources', () => {
  const multimedia = fs.readFileSync(path.join(
    REPOSITORY_ROOT,
    'multimedia/skills/ffmpegImageToVideo/src/ffmpegImageToVideo.mjs',
  ), 'utf8');
  const onlyOffice = fs.readFileSync(path.join(REPOSITORY_ROOT, 'onlyOffice/src/edge-topology.mjs'), 'utf8');
  assert.doesNotMatch(multimedia, /host\.docker\.internal|HOST_LOOPBACK|PLOINKY_ROUTER_URL|PLOINKY_ROUTER_PORT/);
  assert.doesNotMatch(onlyOffice, /PLOINKY_ROUTER_URL/);
});

test('gitAgent keeps the requested embedded profile without protected overrides', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, 'gitAgent/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.profiles?.embedded, {});
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /SOUL_GATEWAY_(?:API_KEY|BASE_URL)|PLOINKY_ROUTER_(?:URL|HOST|PORT)/,
  );
});
