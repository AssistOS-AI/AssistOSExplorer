import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { siblingRoot } from '../../helpers/sibling-roots.mjs';

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
  'userPersistoAgent/lib/auth/managedRouterOrigins.mjs': {
    signals: ['generated-router-key'],
    disposition: 'Detects managed-runtime provenance and delegates fresh authenticated origin reads to the mounted Ploinky runtimeRouterOrigins helper.',
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
  'roboTeamAgent/copilot/src/index.mjs': {
    signals: ['verified-router-client'],
    disposition: 'Starts the background-task manager only when the mounted Ploinky AgentMcpClient exists; it owns no Router transport.',
  },
  'roboTeamAgent/copilot/src/lib/ploinky/agentMcpClient.mjs': {
    signals: ['direct-router-env', 'generated-router-key'],
    disposition: 'Names the generated Router and credential fields to refuse a raw local-credential fallback, and resolves an explicit Router origin only for non-generated callers.',
  },
  'roboTeamAgent/copilot/src/lib/ploinky/roboTeamClient.mjs': {
    signals: ['verified-router-client'],
    disposition: 'Loads the mounted Ploinky AgentMcpClient for RoboTeam MCP calls.',
  },
  'roboTeamAgent/copilot/src/lib/tasks/taskSessionControl.mjs': {
    signals: ['verified-router-client'],
    disposition: 'Loads the mounted Ploinky AgentMcpClient for delegated task control.',
  },
  'roboTeamAgent/copilot/src/lib/webchat/webchatBackgroundTasks.mjs': {
    signals: ['verified-router-client'],
    disposition: 'Loads the mounted Ploinky AgentMcpClient to observe delegated background tasks.',
  },
  'roboTeamAgent/copilot/src/skills/bash/scripts/ploinkyInvocation.mjs': {
    signals: ['verified-router-client'],
    disposition: 'Loads the mounted Ploinky AgentMcpClient, or the SDK copy shipped in the skill context, for skill-script agent calls.',
  },
  'roboTeamAgent/copilot/src/skills/launch-gpt-researcher/scripts/ploinkyInvocation.mjs': {
    signals: ['verified-router-client'],
    disposition: 'Loads the mounted Ploinky AgentMcpClient for the GPTResearcher delegation script.',
  },
  'roboTeamAgent/copilot/src/skills/launch-workflow/scripts/ploinkyInvocation.mjs': {
    signals: ['verified-router-client'],
    disposition: 'Loads the mounted Ploinky AgentMcpClient for the workflow launch script.',
  },
  'roboTeamAgent/copilot/src/skills/list-workflows/scripts/ploinkyInvocation.mjs': {
    signals: ['verified-router-client'],
    disposition: 'Loads the mounted Ploinky AgentMcpClient for the workflow listing script.',
  },
  'roboTeamAgent/server/soul-gateway-connection.mjs': {
    signals: ['generated-router-key'],
    disposition: 'Sends the generated agent credential only through the verified generated-local Router descriptor transport, which refreshes and checks the descriptor before each request.',
  },
  'soul-gateway/deploy.sh': {
    signals: ['direct-router-env'],
    disposition: 'Operator deployment script for the retired standalone host; it reads the Router URL only for its own health probe.',
  },
  'soul-gateway/src/config/env.mjs': {
    signals: ['direct-router-env', 'generated-router-key'],
    disposition: 'Reads the Router origin and the generated credential and key sources into the gateway configuration; it opens no transport.',
  },
  'soul-gateway/src/ploinky/discovery-client.mjs': {
    signals: ['direct-router-env'],
    disposition: 'Signs the agent-assertion discovery request with its own gateway principal against the configured Router origin.',
  },
  'soul-gateway/src/ploinky/reconcile-agents.mjs': {
    signals: ['direct-router-env'],
    disposition: 'Reads the configured Router origin to reconcile discovered agents; the discovery client owns the signed transport.',
  },
  'soul-gateway/src/runtime/backends/builtin/ploinky-agent-openai.backend.mjs': {
    signals: ['direct-router-env'],
    disposition: 'Validates the injected Router origin against the configured origin before routing OpenAI-compatible requests to an agent.',
  },
});

const WEBMEET_DISPOSITIONS = Object.freeze({
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

function assertDispositions(root, dispositions) {
  const observed = {};
  for (const relative of executableFiles(root)) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    const signals = Object.entries(SIGNALS)
      .filter(([, pattern]) => pattern.test(source))
      .map(([name]) => name)
      .sort();
    if (signals.length) observed[relative] = signals;
  }

  assert.deepEqual(
    observed,
    Object.fromEntries(Object.entries(dispositions).map(([relative, disposition]) => [
      relative,
      [...disposition.signals].sort(),
    ])),
  );
  for (const disposition of Object.values(dispositions)) {
    assert.ok(disposition.disposition.length > 20);
  }
}

test('every executable Router consumer has one explicit safe disposition', () => {
  assertDispositions(REPOSITORY_ROOT, DISPOSITIONS);
});

test('every executable Router consumer of the webmeet repository has one explicit safe disposition', () => {
  // The WebMeet agents live in the webmeet sibling checkout; a missing sibling throws.
  assertDispositions(siblingRoot('webmeet'), WEBMEET_DISPOSITIONS);
});

test('legacy multimedia fallbacks are absent from executable sources', () => {
  const multimedia = fs.readFileSync(path.join(
    siblingRoot('legacy-agents'),
    'multimedia/skills/ffmpegImageToVideo/src/ffmpegImageToVideo.mjs',
  ), 'utf8');
  assert.doesNotMatch(multimedia, /host\.docker\.internal|HOST_LOOPBACK|PLOINKY_ROUTER_URL|PLOINKY_ROUTER_PORT/);
});

test('gitAgent keeps the requested embedded profile without protected overrides', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, 'gitAgent/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.profiles?.embedded, {});
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /SOUL_GATEWAY_(?:API_KEY|BASE_URL)|PLOINKY_ROUTER_(?:URL|HOST|PORT)/,
  );
});
