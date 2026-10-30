import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { signIn } from '../lib/auth.mjs';
import { ROBOTEAM_BASE_PATH, roboTeamApi } from '../lib/conversation-skills.mjs';
import { discoverContainers, collectEnvironment, probeZenModels } from '../lib/robowork-e2e.mjs';
import { ProviderStall, makeStallGuard, apiOk } from '../lib/robowork-scenarios.mjs';
import { chatTurn, stopChatTurn, applyModel } from '../lib/robowork-interaction.mjs';

// Provider-liveness preflight (run by scripts/run-robowork-e2e.mjs before a set, or alone with SMOKE_ROBOWORK_PREFLIGHT=1).
// A tiny WebChat turn with a short timeout proves that the coding agent's model answers. If the deployment default stalls, other models that the
// deployment already offers WITHOUT new credentials (the free OpenCode models, listed below or in SMOKE_ROBOWORK_MODELS) are tried in order; the
// first one that answers stays on the e2e robot (the one robot this run owns; `default` and every other robot are never touched) and is written to the
// file named by SMOKE_ROBOWORK_PREFLIGHT_OUT. The robot's own coding agents are sent back unchanged. Before the deployment-default candidate the robot is
// reset to the deployment default, so its label is truthful.
// A model that cannot be listed or needs credentials is never tried. When no model answers the test fails and the runner reports "provider not live".
const enabled = process.env.SMOKE_ROBOWORK_PREFLIGHT === '1';
const DEFAULT_CANDIDATES = ['', 'opencode/deepseek-v4.1-flash-free', 'opencode/mimo-v2.6-flash-free', 'opencode/big-pickle', 'opencode/beam-free', 'opencode/flint-40b-free'];
const candidates = (process.env.SMOKE_ROBOWORK_MODELS ? process.env.SMOKE_ROBOWORK_MODELS.split(',').map((entry) => entry.trim()) : DEFAULT_CANDIDATES);
const TURN_TIMEOUT_MS = Number(process.env.SMOKE_ROBOWORK_PREFLIGHT_TURN_MS || 100_000);
const robotName = process.env.SMOKE_ROBOWORK_ROBOT || 'e2e-bot';

test('provider liveness: a tiny turn gets an answer', async ({ page }, testInfo) => {
  test.skip(!enabled, 'Opt in with SMOKE_ROBOWORK_PREFLIGHT=1.');
  test.setTimeout(candidates.length * (TURN_TIMEOUT_MS + 60_000) + 60_000);
  const workspaceRoot = smokeConfig.workspaceRoot;
  assert.ok(path.isAbsolute(workspaceRoot), 'Set SMOKE_WORKSPACE_ROOT to the deployed workspace.');
  const evidenceDir = path.resolve(process.env.SMOKE_ROBOWORK_EVIDENCE || path.join(smokeConfig.artifactRoot, 'robowork'), 'preflight');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const save = (name, value) => fs.writeFileSync(path.join(evidenceDir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  const containers = discoverContainers({ workspaceRoot });
  save('environment.json', collectEnvironment({ workspaceRoot, containers }));

  await signIn(page, smokeConfig.primaryUser, ROBOTEAM_BASE_PATH);
  let robots = (await apiOk(roboTeamApi, page, { path: 'api/robots' })).robots;
  if (!robots.some((robot) => robot.name === robotName)) {
    await apiOk(roboTeamApi, page, { method: 'POST', path: 'api/robots', body: { name: robotName, codingAgents: ['opencode'] } }, [201]);
    robots = (await apiOk(roboTeamApi, page, { path: 'api/robots' })).robots;
  }
  const e2e = robots.find((robot) => robot.name === robotName);
  const project = `e2e-preflight-${Date.now().toString(36)}`;
  fs.mkdirSync(path.join(workspaceRoot, project), { recursive: true });
  const tried = [];
  let selected = null;
  // One direct request per candidate from the worker's network: a provider quota (429 FreeUsageLimitError) is reported at once instead of after
  // minutes of stalled turns. The deployment default's model id comes from the robot's coding-agent config.
  const deploymentDefault = (await apiOk(roboTeamApi, page, { path: `api/robots/${e2e.id}/coding-agents` })).defaultModels?.opencode ?? '';
  const ids = candidates.map((model) => (model || deploymentDefault).replace(/^opencode\//, ''));
  const probes = probeZenModels(containers, [...new Set(ids)]);
  save('provider-probes.json', probes);
  const probeOf = (model) => probes.find((entry) => entry.model === (model || deploymentDefault).replace(/^opencode\//, ''));
  try {
    for (const model of candidates) {
      const probe = probeOf(model);
      if (probe && probe.status === 429) {
        tried.push({ model: model || '(deployment default)', result: `quota: ${probe.type} (retry-after ${probe.retryAfterSeconds ?? '?'} s)`, ms: probe.ms });
        continue;
      }
      const startedMs = Date.now();
      const entry = { model: model || '(deployment default)', startedAt: new Date().toISOString() };
      tried.push(entry);
      // '' is the deployment default: clear the robot's selection first, so the label is what actually runs.
      const applied = await applyModel(roboTeamApi, page, e2e, model || null);
      entry.apply = { status: applied.status, worker: applied.payload?.worker ?? applied.payload?.error ?? null };
      if (applied.status !== 200) { entry.result = 'not-applicable'; continue; }
      const guard = makeStallGuard({ workspaceRoot, scratchDir: evidenceDir, sinceMs: startedMs - 1000, testInfo, scope: () => ({ cwd: path.join(workspaceRoot, project), robotName }), stallMs: Math.min(TURN_TIMEOUT_MS, 90_000), everyMs: 5_000 });
      try {
        const answer = await chatTurn(page, { robot: robotName, project, prompt: 'Reply with the single word OK.', timeoutMs: TURN_TIMEOUT_MS, check: guard });
        entry.result = 'answered';
        entry.answerChars = answer.length;
        entry.ms = Date.now() - startedMs;
        selected = model;
        break;
      } catch (error) {
        entry.result = error instanceof ProviderStall || /did not finish/.test(String(error?.message)) ? 'stalled' : `error: ${String(error?.message).slice(0, 160)}`;
        entry.ms = Date.now() - startedMs;
        await stopChatTurn(page);
        // The annotation guard added for this attempt belongs to a model we moved away from, not to the set.
        testInfo.annotations.splice(0, testInfo.annotations.length, ...testInfo.annotations.filter((annotation) => annotation.type !== 'rerun-needed'));
        await page.goto(ROBOTEAM_BASE_PATH, { waitUntil: 'load' });
      }
    }
  } finally {
    save('candidates.json', tried);
    fs.rmSync(path.join(workspaceRoot, project), { recursive: true, force: true });
  }
  if (!tried.some((entry) => entry.result === 'answered')) {
    // Nothing answered: the e2e robot goes back to the deployment default before the test fails.
    await applyModel(roboTeamApi, page, e2e, null);
    save('candidates.json', tried);
    testInfo.annotations.push({ type: 'provider-down', description: 'no free model answered a tiny turn' });
    expect(selected, `no model answered a tiny turn: ${JSON.stringify(tried)}`).not.toBeNull();
  }
  const result = { ok: tried.some((entry) => entry.result === 'answered'), selectedModel: selected || null, tried: tried.map((entry) => ({ model: entry.model, result: entry.result, ms: entry.ms })), robotsTouched: [robotName] };
  save('selected-model.json', result);
  if (process.env.SMOKE_ROBOWORK_PREFLIGHT_OUT) fs.writeFileSync(process.env.SMOKE_ROBOWORK_PREFLIGHT_OUT, JSON.stringify(result));
  await testInfo.attach('preflight', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
});
