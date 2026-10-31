import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect } from './fixtures.mjs';
import { smokeConfig } from './config.mjs';
import { setComposer, cancelWebchatGenerationIfActive } from './webchat.mjs';

// Helpers of specs/10-robowork-interaction.spec.mjs (human input, explicit task failure, robot delete). Read-only against the worker.

const BOT = '#chatList > .wa-message.in:not(.wa-typing):not(.wa-task-item) .wa-message-bubble';

function openCopy(workspaceRoot, scratchDir) {
  const source = path.join(workspaceRoot, '.data/robo-work/state/execution-store');
  const copy = fs.mkdtempSync(path.join(scratchDir, 'ledger-copy-'));
  for (const name of ['worker-state.sqlite', 'worker-state.sqlite-wal', 'worker-state.sqlite-shm']) {
    try { fs.copyFileSync(path.join(source, name), path.join(copy, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const db = new DatabaseSync(path.join(copy, 'worker-state.sqlite'), { readOnly: true });
  return { db, close() { db.close(); fs.rmSync(copy, { recursive: true, force: true }); } };
}

// The control records written for the references of the given executions (for example the `answer` of a human-input question).
export function readControls({ workspaceRoot, scratchDir, executionIds }) {
  const handle = openCopy(workspaceRoot, scratchDir);
  try {
    const rows = [];
    for (const executionId of executionIds) {
      const reference = handle.db.prepare('select id from reference where execution_id = ?').get(executionId);
      if (!reference) continue;
      for (const row of handle.db.prepare('select * from reference_control where reference_id = ? order by rowid').all(reference.id)) {
        // The payload can hold the answer text; keep the operation and shape, not the text.
        rows.push({ executionId, ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…(${value.length})` : value])) });
      }
    }
    return rows;
  } finally { handle.close(); }
}

// The worker robot rows (name, id, lifecycle) as the ledger holds them.
export function workerRobots({ workspaceRoot, scratchDir }) {
  const handle = openCopy(workspaceRoot, scratchDir);
  try { return handle.db.prepare('select id, name, lifecycle, uncertain from robot').all(); } finally { handle.close(); }
}

export const workerRobotDirs = (workspaceRoot) => {
  try { return fs.readdirSync(path.join(workspaceRoot, '.data/robo-work/robots')).sort(); } catch { return []; }
};

// Reference event types other than the relayed ALA records and the lifecycle states (M-14 channel events).
export const channelEvents = (execution) => execution.events.filter((event) => !['state', 'ala', 'truncated'].includes(event.type));

export function singleTaskWorkflow({ name, prompt, allowsHumanInput = false, skill = null }) {
  return {
    name, description: `Single-phase e2e workflow ${name}`, entryTaskId: 'p1',
    tasks: [{ id: 'p1', name: 'Phase 1', prompt, skillsets: skill ? [skill] : [], executionType: 'terminal', ...(allowsHumanInput ? { allowsHumanInput: true } : {}) }],
    edges: [],
  };
}

// Sends one WebChat turn to a robot, targeting a project directory under the workspace, and waits for the answer.
export async function chatTurn(page, { robot, project, prompt, timeoutMs = 5 * 60_000, check = null }) {
  const params = new URLSearchParams({ agent: smokeConfig.webchatAgent, robot, 'forward-envelope': '1', 'workspace-dir': project });
  await page.goto(`/webchat?${params}`, { waitUntil: 'load' });
  await expect(page.locator('#cmd')).toBeVisible();
  await page.waitForTimeout(4000);
  const before = await page.locator(BOT).count();
  await setComposer(page, prompt);
  await page.locator('#send').click();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await page.waitForTimeout(2000);
    const texts = await page.locator(BOT).allTextContents();
    const busy = await page.locator('#cancelBtn').isVisible().catch(() => false);
    if (!busy && texts.length > before) return texts.slice(before).join('\n---\n');
    if (check) await check();
    if (Date.now() > deadline) throw new Error(`The turn did not finish within ${timeoutMs / 1000} s.`);
  }
}

// Stops a WebChat generation that is still running (the product's cancel button), so a stalled or abandoned turn does not hold a worker slot.
export async function stopChatTurn(page) {
  try { await cancelWebchatGenerationIfActive(page, { timeout: 30_000 }); return true; } catch { return false; }
}

// Applies a model to a robot through the product API (the robot must be idle). The robot's existing coding agents are sent back unchanged;
// `model: null` clears the selection, which returns the robot to the deployment default. Only robots the run created are ever patched.
export async function applyModel(roboTeamApi, page, robot, model) {
  return roboTeamApi(page, { method: 'PATCH', path: `api/robots/${robot.id}/coding-agents`, body: { codingAgents: robot.codingAgents, model } });
}

// Applies the model the preflight selected (SMOKE_ROBOWORK_MODEL, empty for the deployment default) to a robot a scenario creates.
export async function applySelectedModel(roboTeamApi, page, robot) {
  const model = process.env.SMOKE_ROBOWORK_MODEL || '';
  if (!model) return null;
  return applyModel(roboTeamApi, page, robot, model);
}

// RoboFlow picks any robot whose skills match a phase, including `default`, which keeps the deployment default model. When the scenarios run on
// another model (SMOKE_ROBOWORK_MODEL), the phases are tied to the scenario robot instead: a marker skill that only this robot carries. The skill
// repository is a small test-owned directory under the workspace; attaching it is idempotent. Returns the skill id, or null when no other model is
// in use (then nothing is restricted).
export async function restrictFlowsToRobot(roboTeamApi, page, { workspaceRoot, robotName }) {
  if (!process.env.SMOKE_ROBOWORK_MODEL) return null;
  const repository = path.join(workspaceRoot, 'e2e-skillrepo');
  fs.mkdirSync(path.join(repository, 'e2e-marker'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'e2e-marker/SKILL.md'), '---\nname: e2e-marker\ndescription: Marker skill that only selects the scenario robot.\n---\n\nThis skill carries no instructions.\n');
  const find = async () => (await roboTeamApi(page, { path: 'api/robots' })).payload.robots.find((robot) => robot.name === robotName);
  // The id a workflow task must name is the skill's canonical id: the repository's absolute source path plus the skill name (a relative `repo/skill`
  // form is resolved against the workspace root and matches no robot).
  const skillId = path.join(fs.realpathSync(repository), 'e2e-marker');
  let robot = await find();
  if (!robot) throw new Error(`Robot ${robotName} does not exist; the preflight or an earlier test creates it.`);
  let id = robot?.repositories?.find((entry) => entry.id === 'e2emark') ? skillId : null;
  if (!id) {
    const added = await roboTeamApi(page, { method: 'POST', path: `api/robots/${robot.id}/skillsets`, body: { name: 'e2emark', source: repository, description: 'e2e marker repository' } });
    if (added.status !== 200) throw new Error(`Could not attach the marker skill: HTTP ${added.status} ${JSON.stringify(added.payload).slice(0, 200)}`);
    robot = await find();
    id = robot?.repositories?.find((entry) => entry.id === 'e2emark') ? skillId : null;
  }
  if (!id) throw new Error('The marker skill id is not visible on the scenario robot.');
  return id;
}

// POST to a RoboTeam API path through the APIRequestContext (same session cookies, mutation proof and Origin), so that an EXPECTED refusal (for
// example 409 for a repeated answer) is not logged by the browser as a console error that the strict page diagnostics count against the test.
export async function postQuietly(page, basePath, apiPath, body) {
  const proof = await page.evaluate(async () => (await (await fetch('/auth/token?mutationRoute=roboTeamAgent', { credentials: 'include', cache: 'no-store' })).json()).browserMutation);
  const reply = await page.request.post(`${basePath}${apiPath}`, { headers: { origin: new URL(page.url()).origin, 'x-ploinky-browser-csrf-token': proof.csrfToken, 'content-type': 'application/json', accept: 'application/json' }, data: JSON.stringify(body) });
  return { status: reply.status(), payload: await reply.json().catch(() => ({})) };
}
