import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect } from './fixtures.mjs';
import { smokeConfig } from './config.mjs';
import { setComposer } from './webchat.mjs';

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

export function singleTaskWorkflow({ name, prompt, allowsHumanInput = false }) {
  return {
    name, description: `Single-phase e2e workflow ${name}`, entryTaskId: 'p1',
    tasks: [{ id: 'p1', name: 'Phase 1', prompt, skillsets: [], executionType: 'terminal', ...(allowsHumanInput ? { allowsHumanInput: true } : {}) }],
    edges: [],
  };
}

// Sends one WebChat turn to a robot, targeting a project directory under the workspace, and waits for the answer.
export async function chatTurn(page, { robot, project, prompt, timeoutMs = 5 * 60_000 }) {
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
    if (Date.now() > deadline) throw new Error(`The turn did not finish within ${timeoutMs / 1000} s.`);
  }
}
