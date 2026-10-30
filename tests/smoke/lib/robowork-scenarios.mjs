import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { nested } from './robowork-e2e.mjs';

// Helpers of specs/09-robowork-scenarios.spec.mjs: a wider read-only ledger copy (admissions of every robot after a point in time, with
// their origins, bindings and blockers), worker /proc lookups, an orphan report, and polling. Read-only: nothing here changes the worker.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(description, probe, { timeoutMs = 120_000, intervalMs = 2000, check = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await probe();
    if (last) return last;
    if (check) await check();
    if (Date.now() > deadline) {
      // A model-dependent wait (one with a stall guard) that runs out of time is treated like a stall: rerun-needed, never a pass.
      if (check) { check.mark?.(`timed out waiting for: ${description}`); throw new ProviderStall(`timed out after ${timeoutMs / 1000} s waiting for: ${description}`); }
      throw new Error(`Timed out after ${timeoutMs / 1000} s waiting for: ${description}`);
    }
    await sleep(intervalMs);
  }
}

// A COPY of the ledger (database, WAL, shared memory) opened read-only. `cwd` keeps only executions whose admitted working directory is
// exactly that path (the project of the scenario).
export function readLedgerSince({ workspaceRoot, scratchDir, sinceMs, cwd }) {
  const source = path.join(workspaceRoot, '.data/robo-work/state/execution-store');
  const copy = fs.mkdtempSync(path.join(scratchDir, 'ledger-copy-'));
  try {
    for (const name of ['worker-state.sqlite', 'worker-state.sqlite-wal', 'worker-state.sqlite-shm']) {
      try { fs.copyFileSync(path.join(source, name), path.join(copy, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const db = new DatabaseSync(path.join(copy, 'worker-state.sqlite'), { readOnly: true });
    const all = (sql, ...params) => db.prepare(sql).all(...params);
    const robots = Object.fromEntries(all('select id, name from robot').map((row) => [row.id, row.name]));
    const executions = all('select * from admission where created_at >= ? order by created_at', sinceMs)
      .map((row) => ({ ...row, spec: JSON.parse(row.specification) }))
      .filter((row) => cwd === undefined || row.spec.cwd === cwd)
      .map(({ spec, specification, ...row }) => {
        const reference = all('select id from reference where execution_id = ?', row.execution_id)[0] ?? null;
        return {
          ...row, robotName: robots[row.robot_id] ?? null,
          specification: { cwd: spec.cwd, ignore: spec.ignore, sessionId: spec.sessionId, turnId: spec.turnId, promptChars: spec.prompt?.length },
          origins: all('select namespace, origin_key, origin_id, reference_id, execution_id, created_at from origin where execution_id = ?', row.execution_id),
          events: reference ? all('select sequence, at, type, data from reference_event where reference_id = ? order by sequence', reference.id) : [],
          blockers: all('select resource_id, kind, process_bearing, locator, identity, release_state, retained, created_at, settled_at from resource_blocker where execution_id = ? order by created_at', row.execution_id),
        };
      });
    const dump = { executions, bindings: all('select * from binding order by created_at'), sessions: all('select * from session order by created_at') };
    db.close();
    return dump;
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

export const markerOf = (blocker) => { try { return JSON.parse(blocker.locator).marker ?? null; } catch { return null; } };
export const terminalEvent = (execution) => execution.events.filter((event) => event.type === 'state' && /"state":"(completed|failed|cancelled|interrupted|paused|human-input)"/.test(event.data)).at(-1) ?? null;
export const queuedEvent = (execution) => execution.events.find((event) => event.type === 'state' && event.data.includes('"state":"queued"')) ?? null;

// The ALA `output` records of an execution (the raw stdout/stderr of its shell calls), in order.
export function toolOutputs(execution) {
  return execution.events.filter((event) => event.type === 'ala').map((event) => ({ sequence: event.sequence, record: JSON.parse(event.data).record }))
    .filter(({ record }) => record.type === 'coding-agent-message' && record.outputKind === 'output').map(({ sequence, record }) => ({ sequence, text: String(record.message) }));
}

export function finalText(execution) {
  const record = execution.events.filter((event) => event.type === 'ala').map((event) => JSON.parse(event.data).record).find((entry) => entry.type === 'coding-agent-final');
  return record ? String(record.message) : '';
}

// Command lines in the worker container whose text matches `pattern` (a grep -E expression); at most 40 lines of 300 characters.
export function workerProcesses(containers, pattern) {
  return nested(containers, containers.worker, ['sh', '-c',
    `for p in /proc/[0-9]*; do c=$(tr "\\0" " " < $p/cmdline 2>/dev/null); [ -n "$c" ] && echo "\${p#/proc/} $c"; done | grep -E '${pattern.replace(/'/g, "'\\''")}' | grep -v "grep -E" | cut -c1-300 | head -40`]).trim().split('\n').filter(Boolean);
}

// Leftovers of finished executions in the worker container: network namespaces, nft tables, rw veths, runtime dirs, live sandbox processes.
export function orphanReport(containers) {
  const run = (script) => { try { return nested(containers, containers.worker, ['sh', '-c', script]).trim(); } catch (error) { return `ERR ${String(error.message).slice(0, 200)}`; } };
  return {
    netns: run('ip netns list 2>&1 | head -20'),
    nftTables: run('nft list tables 2>&1 | head -20'),
    rwLinks: run('ip -o link show 2>&1 | grep -c " rw[0-9a-f]\\{10\\}[hn]" || true'),
    runtimeDirs: run('ls -A /var/lib/robo-work/runtime/x 2>&1 | head -20'),
    liveProcesses: workerProcesses(containers, '/usr/bin/bwrap|stage\\.sh|sandboxPrep|providerEndpointMain|ala/bin/ala\\.mjs|opencode'),
  };
}

export function isClean(report) {
  const empty = (text) => text === '' || /^\s*$/.test(text);
  return empty(report.netns) && !/rw_/.test(report.nftTables) && report.rwLinks === '0' && empty(report.runtimeDirs) && report.liveProcesses.length === 0;
}

// Raw JSON helper for RoboTeam routes through the page.
export async function apiOk(roboTeamApi, page, request, expectedStatuses = [200, 201]) {
  const reply = await roboTeamApi(page, request);
  if (!expectedStatuses.includes(reply.status)) throw new Error(`${request.method ?? 'GET'} ${request.path} -> HTTP ${reply.status}: ${JSON.stringify(reply.payload).slice(0, 400)}`);
  return reply.payload;
}

// ---------------------------------------------------------------------------------------------------------------- provider stalls

// A provider stall (the model stops answering, no worker timeout ends it) is neither a pass nor a product failure: the scenario is marked
// `rerun-needed` (a test annotation the runner script reads) and must be run again. It is detected from the worker ledger: an execution
// still `running` whose last relayed event is older than `stallMs`. Deliberate waits in the scenarios (sleep 40..70) stay far below it.
export class ProviderStall extends Error {
  constructor(message) { super(`RERUN-NEEDED: provider stall: ${message}`); this.name = 'ProviderStall'; }
}

export function makeStallGuard({ workspaceRoot, scratchDir, sinceMs, testInfo, stallMs = Number(process.env.SMOKE_ROBOWORK_STALL_MS || 180_000), everyMs = 15_000 }) {
  let last = 0;
  const check = async function check() {
    if (Date.now() - last < everyMs) return;
    last = Date.now();
    const ledger = readLedgerSince({ workspaceRoot, scratchDir, sinceMs });
    for (const execution of ledger.executions) {
      if (execution.state !== 'running') continue;
      const lastAt = Math.max(execution.created_at, ...execution.events.map((event) => event.at));
      if (Date.now() - lastAt > stallMs) {
        testInfo?.annotations.push({ type: 'rerun-needed', description: `execution ${execution.execution_id} idle for ${Math.round((Date.now() - lastAt) / 1000)} s while running` });
        throw new ProviderStall(`execution ${execution.execution_id} (${execution.robotName}) has had no event for ${Math.round((Date.now() - lastAt) / 1000)} s`);
      }
    }
  };
  check.mark = (description) => testInfo?.annotations.push({ type: 'rerun-needed', description });
  return check;
}

// Stops what a scenario left running, through the product APIs: flows are terminated (the worker phase is stopped with them).
export async function terminateFlows(roboTeamApi, page, flowIds) {
  const results = [];
  for (const id of flowIds) {
    try {
      const current = (await roboTeamApi(page, { path: `api/roboflow/flows/${id}?logs=none` })).payload?.flow;
      if (!current || ['completed', 'failed', 'terminated'].includes(current.status)) continue;
      const reply = await roboTeamApi(page, { method: 'POST', path: `api/roboflow/flows/${id}/terminate`, body: {} });
      results.push({ flow: id, status: reply.status });
    } catch (error) { results.push({ flow: id, error: String(error?.message ?? error).slice(0, 200) }); }
  }
  return results;
}
