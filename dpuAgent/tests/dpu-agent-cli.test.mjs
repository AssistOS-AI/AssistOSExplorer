import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { createDpuResearchAgent, parseArguments, parseEnvelope, runWebChat } from '../src/index.mjs';
import { createDpuResearchPlannerTools, normalizeDpuResearchToolArgs, parsePlannerArguments } from '../lib/dpu-research-tools.mjs';
import { verifyWebchatInvocation } from '../lib/webchat-invocation.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the same DPU research agent accepts workspace and Explorer selection context', async () => {
  const calls = [];
  const verificationCalls = [];
  class FakeMainAgent {
    constructor(options) { this.options = options; }
    async executePrompt(prompt, options) {
      calls.push({ prompt, options });
      return { result: JSON.stringify({ providerFacts: [{ provider: 'fixture' }], evidence: [], recommendation: 'Use r1', proposedActions: [] }) };
    }
  }
  const agent = await createDpuResearchAgent({
    MainAgentClass: FakeMainAgent,
    verifyInvocation: async (input) => {
      verificationCalls.push(input);
      return { principalId: 'user:admin' };
    }
  });
  const result = await agent.handleMessage({
    message: 'find Romanian medical data',
    workspace: { id: 'ws1' },
    selection: { resourceId: 'r1' },
    invocationToken: 'router-token'
  });
  assert.equal(result.recommendation, 'Use r1');
  assert.match(calls[0].prompt, /Romanian medical data/);
  assert.match(calls[0].prompt, /resourceId/);
  assert.match(calls[0].options.systemPrompt, /Never invent provider facts/);
  assert.equal(verificationCalls[0].invocationToken, 'router-token');
  assert.equal(Object.hasOwn(calls[0].options.context, 'invocationToken'), false);
});

test('the planner exposes the exact P1 DPU research tools with verified auth', async () => {
  const toolCalls = [];
  class ToolCallingMainAgent {
    constructor() { this.context = null; }
    _buildToolsForSession() { return {}; }
    async executePrompt() {
      const tools = this._buildToolsForSession();
      assert.equal(typeof tools.dpu_research_search?.handler, 'function');
      assert.equal(typeof tools.dpu_source_list?.handler, 'function');
      assert.equal(tools.dpu_source_search, undefined);
      await tools.dpu_research_search.handler(null, [
        '```json',
        JSON.stringify({ query: 'Romanian language datasets', limit: 10 }, null, 2),
        '```'
      ].join('\n'));
      return { result: JSON.stringify({ providerFacts: [], evidence: [], recommendation: 'done', proposedActions: [] }) };
    }
  }
  const verifiedAuth = { principalId: 'user:admin' };
  const agent = await createDpuResearchAgent({
    MainAgentClass: ToolCallingMainAgent,
    verifyInvocation: async () => verifiedAuth,
    executeTool: async (name, authInfo, args) => {
      toolCalls.push({ name, authInfo, args });
      return { results: [] };
    }
  });

  await agent.handleMessage({ message: 'find Romanian datasets', invocationToken: 'router-token' });
  assert.deepEqual(toolCalls, [{
    name: 'dpu_research_search',
    authInfo: verifiedAuth,
    args: { query: 'Romanian language datasets', limit: 10 }
  }]);
});

test('planner arguments require one strict fenced JSON object', () => {
  assert.deepEqual(parsePlannerArguments([
    '```json',
    '{"query":"Romanian language datasets","limit":10}',
    '```'
  ].join('\n')), {
    query: 'Romanian language datasets',
    limit: 10
  });

  assert.throws(
    () => parsePlannerArguments('{"query":"Romanian language datasets"}'),
    /exactly one JSON object in a fenced/
  );
  assert.throws(
    () => parsePlannerArguments('Arguments:\n```json\n{"query":"Romanian"}\n```'),
    /no surrounding text/
  );
  assert.throws(
    () => parsePlannerArguments('```\n{"query":"Romanian"}\n```'),
    /fenced ```json Markdown block/
  );
  assert.throws(
    () => parsePlannerArguments('```json\n{"query":}\n```'),
    /one valid JSON object/
  );
  assert.throws(
    () => parsePlannerArguments('```json\n["Romanian"]\n```'),
    /one valid JSON object/
  );
});

test('research search accepts provider filters and only exact DPU source UUIDs', () => {
  assert.deepEqual(normalizeDpuResearchToolArgs('dpu_research_search', {
    query: 'Romanian datasets',
    providerTypes: ['HuggingFace'],
    sourceIds: ['72807eb2-8eb0-4a4c-8cb8-8bb5778b2c62'],
    limit: 10
  }), {
    query: 'Romanian datasets',
    providerTypes: ['huggingface'],
    sourceIds: ['72807eb2-8eb0-4a4c-8cb8-8bb5778b2c62'],
    limit: 10
  });
  assert.throws(
    () => normalizeDpuResearchToolArgs('dpu_research_search', {
      query: 'Romanian datasets',
      sourceIds: ['huggingface']
    }),
    /Provider types and names are not source IDs/
  );
});

test('known provider labels placed in sourceIds are recovered without another planning turn', async () => {
  const calls = [];
  const tools = createDpuResearchPlannerTools({
    getAuthInfo: () => ({ principalId: 'user:admin' }),
    executeTool: async (...args) => {
      calls.push(args);
      return { ok: true, items: [] };
    }
  });
  const result = JSON.parse(await tools.dpu_research_search.handler(null, [
    '```json',
    JSON.stringify({
      query: 'Romanian language datasets',
      sourceIds: ['huggingface'],
      limit: 10
    }, null, 2),
    '```'
  ].join('\n')));

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [[
    'dpu_research_search',
    { principalId: 'user:admin' },
    { query: 'Romanian language datasets', providerTypes: ['huggingface'], limit: 10 }
  ]]);
});

test('unknown source labels remain recoverable and never dispatch provider work', async () => {
  const calls = [];
  const tools = createDpuResearchPlannerTools({
    getAuthInfo: () => ({ principalId: 'user:admin' }),
    executeTool: async (...args) => {
      calls.push(args);
      return { ok: true, items: [] };
    }
  });
  const result = JSON.parse(await tools.dpu_research_search.handler(null, [
    '```json',
    '{"query":"Romanian datasets","sourceIds":["huggingface","unknown-provider"],"limit":1}',
    '```'
  ].join('\n')));

  assert.equal(result.recoverable, true);
  assert.equal(result.code, 'invalid_source_ids');
  assert.deepEqual(result.retry.arguments, { query: 'Romanian datasets', providerTypes: ['huggingface'], limit: 1 });
  assert.deepEqual(calls, []);
});

test('a completed research search is returned when the planner rejects an empty provider response', async () => {
  const warnings = [];
  class EmptyAfterSearchMainAgent {
    _buildToolsForSession() { return {}; }
    async executePrompt() {
      const tools = this._buildToolsForSession();
      await tools.dpu_research_search.handler(null, '```json\n{"query":"small Romanian text dataset","providerTypes":["huggingface"],"limit":1}\n```');
      throw new Error('provider returned empty content');
    }
  }
  const resource = { id: 'resource-1', provider: 'huggingface', externalId: 'owner/ro-small', revision: 'sha-1', accessState: 'available' };
  const agent = await createDpuResearchAgent({
    MainAgentClass: EmptyAfterSearchMainAgent,
    verifyInvocation: async () => ({ principalId: 'user:admin' }),
    executeTool: async () => ({ ok: true, items: [resource] }),
    logger: { warn: (message) => warnings.push(message) }
  });

  const result = await agent.handleMessage({ message: 'find one small Romanian text dataset', invocationToken: 'router-token' });
  assert.equal(result.evidence[0].id, 'resource-1');
  assert.match(result.recommendation, /1 matching research resource/);
  assert.match(warnings[0], /Planner failed/);
  assert.doesNotMatch(warnings[0], /provider returned/);
});

test('search fallback never hides a later DPU tool result', async () => {
  class FailureAfterLaterToolMainAgent {
    _buildToolsForSession() { return {}; }
    async executePrompt() {
      const tools = this._buildToolsForSession();
      await tools.dpu_research_search.handler(null, '```json\n{"query":"Romanian","limit":1}\n```');
      await tools.dpu_resource_get.handler(null, '```json\n{"id":"resource-1"}\n```');
      throw new Error('empty provider content after resource inspection');
    }
  }
  const agent = await createDpuResearchAgent({
    MainAgentClass: FailureAfterLaterToolMainAgent,
    verifyInvocation: async () => ({ principalId: 'user:admin' }),
    executeTool: async (name) => name === 'dpu_research_search'
      ? { ok: true, items: [{ id: 'resource-1' }] }
      : { ok: true, resource: { id: 'resource-1' } },
    logger: { warn() {} }
  });

  await assert.rejects(
    agent.handleMessage({ message: 'inspect a Romanian dataset', invocationToken: 'router-token' }),
    /empty provider content/
  );
});

test('WebChat invocation verification fails closed without a router token', async () => {
  await assert.rejects(
    verifyWebchatInvocation({ message: 'find datasets' }),
    /Authenticated WebChat invocation is required/
  );
});

test('WebChat launch arguments do not become a research message', () => {
  assert.deepEqual(parseArguments([
    '--pageInstanceId=0cde6fb6-d639-4f90-a540-46d718142eb9',
    '--forward-envelope=1',
    '--dir=/workspace',
    '--dpu-resource-id=913628a2-6c8f-491b-b684-352efa391a3d'
  ]), {
    once: false,
    json: false,
    message: '',
    workspaceDir: '/workspace',
    pageInstanceId: '0cde6fb6-d639-4f90-a540-46d718142eb9',
    forwardEnvelope: true,
    dpuResourceId: '913628a2-6c8f-491b-b684-352efa391a3d'
  });
});

test('WebChat envelope preserves verified invocation and references', () => {
  const parsed = parseEnvelope(JSON.stringify({
    __webchatMessage: 1,
    text: 'find Romanian datasets',
    invocation: { token: 'router-token' },
    presentation: { visible: false },
    sourceTabId: 'tab-1',
    sourcePageInstanceId: 'page-1',
    attachments: [{ id: 'attachment-1', filename: 'notes.txt' }],
    references: [{ kind: 'workspace-path', path: 'notes.md', type: 'file' }]
  }), { workspace: { root: '/workspace' } });
  assert.equal(parsed.message, 'find Romanian datasets');
  assert.equal(parsed.invocationToken, 'router-token');
  assert.equal(parsed.workspace.root, '/workspace');
  assert.equal(parsed.selection.references[0].path, 'notes.md');
  assert.equal(parsed.presentation.visible, false);
  assert.equal(parsed.sourceTabId, 'tab-1');
  assert.equal(parsed.sourcePageInstanceId, 'page-1');
  assert.equal(parsed.attachments[0].filename, 'notes.txt');
});

test('WebChat processes an envelope before its non-TTY input pipe closes', async () => {
  const input = new PassThrough();
  let output = '';
  let outputWritten;
  const outputPromise = new Promise((resolve) => { outputWritten = resolve; });
  const outputStream = new Writable({
    write(chunk, encoding, callback) {
      output += chunk.toString();
      if (output.includes('"recommendation": "done"')) outputWritten();
      callback();
    }
  });
  let handled;
  const handledPromise = new Promise((resolve) => { handled = resolve; });
  const agent = {
    async handleMessage(turn) {
      handled(turn);
      return { providerFacts: [], evidence: [], recommendation: 'done', proposedActions: [] };
    }
  };

  const running = runWebChat(agent, {
    input,
    output: outputStream,
    workspace: { root: '/workspace' },
    selection: { kind: 'dpu-research-resource', resourceId: 'resource-1' }
  });
  input.write(`${JSON.stringify({ __webchatMessage: 1, version: 1, text: 'find datasets' })}\n`);

  const turn = await handledPromise;
  await outputPromise;
  assert.equal(turn.message, 'find datasets');
  assert.equal(turn.workspace.root, '/workspace');
  assert.deepEqual(turn.selection, { kind: 'dpu-research-resource', resourceId: 'resource-1' });
  assert.match(output, /"recommendation": "done"/);

  input.end();
  await running;
});

test('WebChat handles silent task discovery locally before the next research request', async () => {
  const input = new PassThrough();
  let output = '';
  let researchOutputWritten;
  const researchOutputPromise = new Promise((resolve) => { researchOutputWritten = resolve; });
  const outputStream = new Writable({
    write(chunk, encoding, callback) {
      output += chunk.toString();
      if (output.includes('"recommendation": "Romanian results"')) researchOutputWritten();
      callback();
    }
  });
  const calls = [];
  const agent = {
    async handleMessage(turn) {
      calls.push(turn);
      return { providerFacts: [], evidence: [], recommendation: 'Romanian results', proposedActions: [] };
    }
  };

  const running = runWebChat(agent, { input, output: outputStream });
  input.write(`${JSON.stringify({
    __webchatMessage: 1,
    version: 1,
    text: '/tasks',
    presentation: { visible: false }
  })}\n`);
  input.write(`${JSON.stringify({
    __webchatMessage: 1,
    version: 1,
    text: 'Search the enabled Hugging Face source for Romanian language datasets.',
    presentation: { visible: true }
  })}\n`);

  await researchOutputPromise;
  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /Romanian language datasets/);
  assert.match(output, /"__webchatTask":1/);
  assert.match(output, /"event":"list"/);
  assert.match(output, /"tasks":\[\]/);

  input.end();
  await running;
});

test('a failed WebChat request does not close the loop or block the next request', async () => {
  const input = new PassThrough();
  let output = '';
  let recoveredOutputWritten;
  const recoveredOutputPromise = new Promise((resolve) => { recoveredOutputWritten = resolve; });
  const outputStream = new Writable({
    write(chunk, encoding, callback) {
      output += chunk.toString();
      if (output.includes('"recommendation": "recovered"')) recoveredOutputWritten();
      callback();
    }
  });
  let callCount = 0;
  const agent = {
    async handleMessage() {
      callCount += 1;
      if (callCount === 1) throw new Error('provider payload must not be exposed');
      return { providerFacts: [], evidence: [], recommendation: 'recovered', proposedActions: [] };
    }
  };

  const running = runWebChat(agent, { input, output: outputStream });
  input.write(`${JSON.stringify({ __webchatMessage: 1, version: 1, text: 'first request' })}\n`);
  input.write(`${JSON.stringify({ __webchatMessage: 1, version: 1, text: 'second request' })}\n`);

  await recoveredOutputPromise;
  assert.equal(callCount, 2);
  assert.match(output, /could not be completed/);
  assert.doesNotMatch(output, /provider payload/);

  input.end();
  await running;
});

test('DPU Research launcher uses the standard Explorer tools slot and WebChat envelope', async () => {
  const manifest = JSON.parse(await fs.promises.readFile(path.join(repoRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.webchat?.forwardEnvelope, true);

  const pluginRoot = path.join(repoRoot, 'IDE-plugins', 'dpu-research-tool-button');
  const config = JSON.parse(await fs.promises.readFile(path.join(pluginRoot, 'config.json'), 'utf8'));
  assert.deepEqual(config.location, ['file-exp:toolbar-plugins-dropdown']);
  const template = await fs.promises.readFile(path.join(pluginRoot, 'dpu-research-tool-button.html'), 'utf8');
  const presenter = await fs.promises.readFile(path.join(pluginRoot, 'dpu-research-tool-button.js'), 'utf8');
  assert.match(template, /app-plugin-tool-button/);
  const target = new URL(config.toolbarModal.url, 'https://workspace.example');
  assert.equal(config.toolbarModal.mode, 'iframe');
  assert.equal(target.pathname, '/webchat');
  assert.equal(target.searchParams.get('agent'), 'dpuAgent');
  assert.equal(target.searchParams.get('forward-envelope'), '1');
  assert.equal(target.searchParams.get('workspace-dir'), '.');
  assert.match(presenter, /openPluginPanel\('dpuAgent\/dpu-research-launcher'\)/);
  assert.doesNotMatch(presenter, /window\.open/);
});

test('DPU Tools action delegates to Explorer and releases the click handler', async t => {
  const { DpuResearchToolButton } = await import('../IDE-plugins/dpu-research-tool-button/dpu-research-tool-button.js');
  const previous = globalThis.assistOS;
  t.after(() => { if (previous === undefined) delete globalThis.assistOS; else globalThis.assistOS = previous; });
  const calls = [];
  const button = new EventTarget();
  button.setAttribute = () => {};
  const element = { isConnected: true, dataset: {}, querySelector: selector => selector === '#dpuResearchToolButton' ? button : {} };
  globalThis.assistOS = { UI: { openPluginPanel: key => calls.push(key) } };
  const presenter = new DpuResearchToolButton(element, () => {});
  presenter.afterRender();
  presenter.afterRender();
  button.dispatchEvent(new Event('click'));
  assert.deepEqual(calls, ['dpuAgent/dpu-research-launcher']);
  presenter.afterUnload();
  button.dispatchEvent(new Event('click'));
  assert.equal(calls.length, 1);
});
