import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The router-request verifier and hash come from the sibling Ploinky checkout,
// exactly as the container mounts them at /Agent.
const agentRoot = fileURLToPath(new URL('..', import.meta.url));
const ploinkyRoot = fileURLToPath(new URL('../../../ploinky', import.meta.url));
const agentLibRoot = process.env.PLOINKY_AGENTLIB_DIR || path.join(ploinkyRoot, 'node_modules/achillesAgentLib');
const AUDIENCE = 'agent:AssistOSExplorer/dpuAgent';
const SECRET = randomBytes(32);
process.env.PLOINKY_AGENTLIB_DIR = agentLibRoot;
process.env.PLOINKY_AGENT_RUNTIME_ROOT = path.join(ploinkyRoot, 'Agent');
process.env.PLOINKY_AGENT_ID = AUDIENCE;
process.env.PLOINKY_AGENT_SECRET = SECRET.toString('hex');
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dpu-webchat-sso-'));
process.env.DPU_DATA_ROOT = dataRoot;
process.env.DPU_MASTER_KEY = 'webchat-sso-test-key';

const { signHmacJwt } = await import(pathToFileURL(path.join(agentLibRoot, 'jwt/jwtSign.mjs')).href);
const { computeRchTool } = await import(pathToFileURL(path.join(ploinkyRoot, 'Agent/lib/requestHash.mjs')).href);
const { MainAgent } = await import(pathToFileURL(path.join(agentLibRoot, 'index.mjs')).href);
const { authInfoFromInvocation } = await import('../../shared/invocation-auth.mjs');
const { createDpuResearchAgent, parseArguments, runWebChat } = await import('../src/index.mjs');
const { verifyWebchatInvocation } = await import('../lib/webchat-invocation.mjs');
const { DPU_RESEARCH_TOOL_DEFINITIONS, executeDpuResearchTool } = await import('../lib/dpu-research-tools.mjs');
const research = await import('../lib/dpu-research.mjs');
const { putSecret } = await import('../lib/dpu-store.mjs');
const { createSourceAdapterRegistry } = await import('../lib/source-adapters/source-adapter.mjs');
const { resolveActor } = await import('../lib/dpu-store-internal/identity-acl.mjs');

test.after(async () => fs.rm(dataRoot, { recursive: true, force: true }));

const USERS = {
  O: { id: 'sso:owner', roles: ['user'] },
  U: { id: 'sso:member', roles: ['user'] },
  A: { id: 'sso:administrator', roles: ['user', 'admin'] },
  B: { id: 'sso:bob', roles: ['user'] }
};

function webchatArgs(text, { runtimeScope = 'principal', tabId = 'tab-1', pageInstanceId = 'page-1' } = {}) {
  return {
    surface: 'webchat',
    tabId,
    pageInstanceId,
    text,
    attachments: [],
    references: [],
    presentation: { visible: true },
    ...(runtimeScope ? { runtimeScope } : {})
  };
}

// Mints the Router Request exactly as the router does for a browser user:
// sub and actor come from req.user, and rch binds the signed arguments.
function mintWebchatToken(user, args, { actorKind = 'user' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const sub = `user:${user.id}`;
  return signHmacJwt({
    secret: SECRET,
    payload: {
      typ: 'router-request',
      iss: 'ploinky-router',
      aud: AUDIENCE,
      sub,
      actor: { kind: actorKind, id: sub, roles: user.roles },
      method: 'POST',
      path: '/mcp',
      tool: '__webchat_message__',
      rch: computeRchTool({ method: 'POST', path: '/mcp', tool: '__webchat_message__', arguments: args }),
      jti: randomUUID(),
      iat: now,
      exp: now + 30
    }
  });
}

function turnFor(user, text, options = {}) {
  return {
    message: text,
    invocationToken: mintWebchatToken(user, webchatArgs(text, options), options),
    sourceTabId: options.tabId || 'tab-1',
    sourcePageInstanceId: options.pageInstanceId || 'page-1',
    presentation: { visible: true }
  };
}

async function webchatAuthInfo(user) {
  const text = `whoami ${randomUUID()}`;
  return verifyWebchatInvocation({
    invocationToken: mintWebchatToken(user, webchatArgs(text)),
    message: text,
    sourceTabId: 'tab-1',
    sourcePageInstanceId: 'page-1'
  });
}

function countingAgent() {
  const counts = { prompts: 0, tools: 0 };
  const actors = [];
  class CountingMainAgent {
    _buildToolsForSession() { return {}; }
    async executePrompt() {
      counts.prompts += 1;
      const tools = this._buildToolsForSession();
      await tools.dpu_resource_list.handler(null, '```json\n{}\n```');
      return { result: JSON.stringify({ providerFacts: [], evidence: [], recommendation: 'done', proposedActions: [] }) };
    }
  }
  return {
    counts,
    actors,
    create: () => createDpuResearchAgent({
      MainAgentClass: CountingMainAgent,
      executeTool: async (name, authInfo) => {
        counts.tools += 1;
        actors.push(authInfo);
        return { ok: true, items: [] };
      }
    })
  };
}

test('a WebChat token minted by an old router without runtimeScope is rejected before any LLM or tool call', async () => {
  const harness = countingAgent();
  const agent = await harness.create();
  const oldRouterTurn = turnFor(USERS.U, 'list my resources', { runtimeScope: '' });
  await assert.rejects(agent.handleMessage(oldRouterTurn), /WebChat invocation verification failed/);
  assert.deepEqual(harness.counts, { prompts: 0, tools: 0 });

  // Through the WebChat loop the user sees only the existing generic line.
  const input = new PassThrough();
  let output = '';
  const outputStream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback(); } });
  const running = runWebChat(agent, { input, output: outputStream, logger: null });
  input.end(`${JSON.stringify({
    __webchatMessage: 1,
    version: 1,
    text: 'list my resources',
    invocation: { token: mintWebchatToken(USERS.U, webchatArgs('list my resources', { runtimeScope: '' })) },
    sourceTabId: 'tab-1',
    sourcePageInstanceId: 'page-1'
  })}\n`);
  await running;
  assert.equal(output, 'The DPU research request could not be completed. You can send another request.\n');
  assert.deepEqual(harness.counts, { prompts: 0, tools: 0 });
});

test('positive control: a principal-scoped WebChat token is accepted and the WebChat user is the actor', async () => {
  const harness = countingAgent();
  const agent = await harness.create();
  const result = await agent.handleMessage(turnFor(USERS.U, 'list my resources'));
  assert.equal(result.recommendation, 'done');
  assert.deepEqual(harness.counts, { prompts: 1, tools: 1 });
  assert.equal(harness.actors[0].principalId, `user:${USERS.U.id}`);
});

test('a WebChat process is pinned to its first verified principal', async () => {
  const harness = countingAgent();
  const agent = await harness.create();

  // A token that fails verification never pins the process.
  await assert.rejects(agent.handleMessage(turnFor(USERS.B, 'first', { runtimeScope: '' })), /verification failed/);
  assert.deepEqual(harness.counts, { prompts: 0, tools: 0 });

  await agent.handleMessage(turnFor(USERS.U, 'mine'));
  assert.deepEqual(harness.counts, { prompts: 1, tools: 1 });

  await assert.rejects(agent.handleMessage(turnFor(USERS.B, 'someone else')), (error) => {
    assert.equal(error.code, 'principal_mismatch');
    assert.doesNotMatch(String(error.message), /sso:member|sso:bob/);
    return true;
  });
  assert.deepEqual(harness.counts, { prompts: 1, tools: 1 }, 'a different principal reaches no LLM or tool call');

  await agent.handleMessage(turnFor(USERS.U, 'mine again'));
  assert.deepEqual(harness.counts, { prompts: 2, tools: 2 });
  assert.ok(harness.actors.every((authInfo) => authInfo.principalId === `user:${USERS.U.id}`));

  // A grant without a user principal (for example a guest actor) is refused.
  const guestHarness = countingAgent();
  const guestAgent = await guestHarness.create();
  await assert.rejects(
    guestAgent.handleMessage(turnFor({ id: 'guest', roles: ['guest'] }, 'hello', { actorKind: 'guest' })),
    (error) => error.code === 'principal_required'
  );
  assert.deepEqual(guestHarness.counts, { prompts: 0, tools: 0 });
});

test('launch flags and SSO_* environment values have no effect on the actor', async () => {
  const previous = { SSO_USER_ID: process.env.SSO_USER_ID, SSO_ROLES: process.env.SSO_ROLES, SSO_USER: process.env.SSO_USER };
  process.env.SSO_USER_ID = 'admin';
  process.env.SSO_USER = 'admin';
  process.env.SSO_ROLES = 'admin';
  try {
    const options = parseArguments(['--forward-envelope=1', '--sso-user-id=admin', '--sso-roles=admin']);
    assert.equal(options.forwardEnvelope, true);
    const harness = countingAgent();
    const agent = await harness.create();
    await agent.handleMessage(turnFor(USERS.U, 'list my resources'));
    const actor = resolveActor(harness.actors[0]);
    assert.equal(actor.principalId, `user:${USERS.U.id}`);
    assert.deepEqual(actor.roles, ['user']);
    await assert.rejects(
      executeDpuResearchTool('dpu_source_list', harness.actors[0], {}),
      /admin role/,
      'the flag and environment never grant DPU admin'
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('P1: the WebChat grant and the Explorer MCP grant resolve the same DPU principal', async () => {
  const webchat = await webchatAuthInfo(USERS.U);
  // Explorer's MCP path receives the router grant for the same browser user.
  const mcp = authInfoFromInvocation({
    typ: 'router-request',
    iss: 'ploinky-router',
    aud: AUDIENCE,
    sub: `user:${USERS.U.id}`,
    actor: { kind: 'user', id: `user:${USERS.U.id}`, roles: USERS.U.roles },
    tool: 'dpu_resource_list'
  }, { invocationToken: 'verified-router-request' });
  assert.equal(webchat.principalId, mcp.principalId);
  assert.equal(resolveActor(webchat).principalId, resolveActor(mcp).principalId);
  assert.deepEqual(resolveActor(webchat).roles, resolveActor(mcp).roles);
});

test('the real planner exposes exactly the DPU research tools and no secret tools', async () => {
  const agent = await createDpuResearchAgent({ MainAgentClass: MainAgent });
  const names = Object.keys(agent.mainAgent._buildToolsForSession()).sort();
  assert.deepEqual(names, DPU_RESEARCH_TOOL_DEFINITIONS.map((definition) => definition.name).sort());
  assert.equal(names.some((name) => name.startsWith('dpu_secret_')), false);
});

test('the DPU manifest borrows Explorer SSO with a per-user WebChat runtime', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(agentRoot, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.webchat, { auth: 'static', forwardEnvelope: true, runtimeScope: 'principal' });
});

test('WebChat principals keep every DPU ACL decision (O owner, U member, A admin)', async () => {
  const [O, U, A] = await Promise.all([webchatAuthInfo(USERS.O), webchatAuthInfo(USERS.U), webchatAuthInfo(USERS.A)]);
  const tool = (name, authInfo, args = {}) => executeDpuResearchTool(name, authInfo, args);

  const registered = await tool('dpu_resource_register', O, { provider: 'manual', externalId: 'owner/private', name: 'Owner data' });
  const R = registered.resource.id;
  const listed = async (authInfo) => (await tool('dpu_resource_list', authInfo)).items.map((item) => item.id);
  assert.ok((await listed(O)).includes(R));
  assert.equal((await listed(U)).includes(R), false);
  assert.equal((await listed(A)).includes(R), false, 'admins get no implicit resource access');

  assert.equal((await tool('dpu_resource_get', O, { id: R })).ok, true);
  await assert.rejects(tool('dpu_resource_get', U, { id: R }), /Access denied/);
  await assert.rejects(tool('dpu_resource_get', A, { id: R }), /Access denied/);
  const orphan = await tool('dpu_resource_get', U, { id: randomUUID() });
  assert.equal(orphan.ok, false);

  const ownerShare = await tool('dpu_resource_share', O, { id: R, principal: `user:${USERS.U.id}`, role: 'read' });
  assert.equal(ownerShare.ok, true);
  assert.equal((await tool('dpu_resource_revoke', O, { id: R, principal: 'user:nobody' })).ok, true);
  for (const actor of [U, A]) {
    await assert.rejects(tool('dpu_resource_share', actor, { id: R, principal: 'user:x', role: 'read' }), /Access denied/);
    await assert.rejects(tool('dpu_resource_revoke', actor, { id: R, principal: 'user:x' }), /Access denied/);
  }

  // U receives read through the ACL: get works, write operations stay denied.
  assert.equal((await tool('dpu_action_confirm', U, { id: ownerShare.proposal.id })).ok, false);
  await tool('dpu_action_confirm', O, { id: ownerShare.proposal.id });
  assert.equal((await tool('dpu_resource_get', U, { id: R })).resource.role, 'read');
  await assert.rejects(tool('dpu_resource_share', U, { id: R, principal: 'user:x', role: 'read' }), /Access denied/);

  // Source management is admin-only.
  for (const actor of [U, O]) await assert.rejects(tool('dpu_source_list', actor), /admin role/);
  assert.equal((await tool('dpu_source_list', A)).ok, true);

  // Jobs are visible to their actor and to admins only.
  const fixture = {
    getCapabilities: () => ['search', 'metadata', 'download'],
    testConnection: async () => ({ ok: true }),
    discover: async ({ source, query }) => [{
      provider: 'fixture', sourceId: source.id, externalId: `dataset/${query}`, name: query,
      revision: '1', accessState: 'available', executionMode: 'remote'
    }],
    describe: async ({ resource }) => resource,
    resolveAccess: async () => ({ accessState: 'pending' }),
    acquire: async () => ({ revision: '1', fileManifest: [] }),
    getCitation: async () => ({ citation: '' })
  };
  const registry = createSourceAdapterRegistry({ fixture });
  const gated = await research.registerResource(O, {
    provider: 'fixture', sourceId: 'none', externalId: 'gated/owner', accessState: 'pending', executionMode: 'remote'
  }, { trustedProvider: true });
  const J = (await research.acquireResource(O, { id: gated.resource.id }, { registry })).job.id;
  assert.equal((await tool('dpu_job_get', O, { id: J })).ok, true);
  assert.equal((await tool('dpu_job_get', A, { id: J })).ok, true);
  assert.equal((await tool('dpu_job_get', U, { id: J })).ok, false);

  // A source backed by O's secret S is usable by O and A, not by U.
  await putSecret(O, { key: 'OWNER_PROVIDER_TOKEN', value: 'owner-provider-token' });
  const source = await research.upsertSource(A, { name: 'Owner credential source', type: 'fixture', secretRef: 'OWNER_PROVIDER_TOKEN' }, { registry });
  for (const actor of [O, A]) {
    const found = await research.searchResearch(actor, { query: 'credential-use', sourceIds: [source.source.id] }, { registry });
    assert.equal(found.ok, true);
  }
  await assert.rejects(
    research.searchResearch(U, { query: 'credential-use', sourceIds: [source.source.id] }, { registry }),
    /credential access/
  );
});
