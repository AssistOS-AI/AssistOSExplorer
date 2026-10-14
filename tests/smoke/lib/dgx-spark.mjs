// DGX Spark (NVIDIA GB10, unified memory) E2E helpers for specs 93-96.
//
// The suite runs against the Explorer deployment of one workspace (SMOKE_WORKSPACE_ROOT) and the Ploinky checkout that
// created it (SMOKE_PLOINKY_BIN). The Box is resolved from that workspace through `ploinky gpu status` and proved with the
// outer engine, never taken from a free-form name. Every prerequisite that is missing fails; nothing is skipped. This is
// a hardware E2E profile, not a release-acceptance gate: it records its own provenance instead of a release bundle.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { inspectBoxWorkspace } from './box-workspace.mjs';
import { openExplorer } from './explorer.mjs';
import { MIB, checked, checkedJson, coreArgs, nestedArgs, validateBoxName } from './hardware-limits-evidence.mjs';

export const GIB = 1024 * MIB;
export const DGX_GPU = Object.freeze({ name: 'NVIDIA GB10', pciDeviceId: '0x2E1210DE', computeCapability: '12.1', addressingMode: 'ATS' });
export const LOCAL_LLM_REF = 'local-llms/local-llm';
export const LOCAL_LLM_ROUTE = 'local-llm';
export const GPU_CDI_DEVICE = 'ploinky.local/gpu=all';
export const BOX_NVIDIA_DEVICES = Object.freeze(['/dev/nvidia0', '/dev/nvidiactl', '/dev/nvidia-uvm']);
export const UNIFIED_RUNNER = 'llama.cpp';
export const CPU_RUNNER = 'llama.cpp-cpu';
export const UNIFIED_HOST_RESERVE_BYTES = 16 * GIB;
export const UNIFIED_FLOOR_BYTES = 8 * GIB;
export const ACTIVE_PHASES = Object.freeze(new Set(['downloading', 'copying', 'verifying', 'pulling', 'starting', 'loading', 'ready', 'stopping']));
const NESTED_PREFIX = 'ploinky_';

// ---------------------------------------------------------------------------
// Commands

// Like hardware-limits-evidence defaultRun, plus an explicit complete environment (`env` replaces process.env).
export function runCommand(command, args, { timeoutMs = 20_000, cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, {
      cwd,
      env: env || process.env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    }, (error, stdout, stderr) => {
      resolve({
        status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        signal: error?.signal ?? null,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error && typeof error.code !== 'number' ? error : null,
      });
    });
    child.stdin?.end();
  });
}

const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value ?? '').trim());

export function dgxSparkEnabled(env = process.env) {
  return truthy(env.SMOKE_DGX_SPARK);
}

// The workspace and the Ploinky executable that created it. SMOKE_PLOINKY_BOX_CONTAINER is refused on purpose: the Box
// is derived from the workspace, so the suite cannot be pointed at another workspace's Box by name.
export function requireDgxSparkEnvironment(env = process.env) {
  const problems = [];
  const workspaceRoot = String(env.SMOKE_WORKSPACE_ROOT || '').trim();
  if (!path.isAbsolute(workspaceRoot)) problems.push('SMOKE_WORKSPACE_ROOT must be the absolute workspace directory of the deployment');
  else if (!fs.existsSync(path.join(workspaceRoot, '.ploinky'))) problems.push(`SMOKE_WORKSPACE_ROOT (${workspaceRoot}) holds no .ploinky workspace`);
  // Ploinky derives the Box identity from path.resolve of the root, so a symlinked spelling would name another Box.
  else if (fs.realpathSync(workspaceRoot) !== path.resolve(workspaceRoot)) problems.push(`SMOKE_WORKSPACE_ROOT (${workspaceRoot}) must be its own real path, not a symlink`);
  const ploinkyBin = String(env.SMOKE_PLOINKY_BIN || '').trim();
  if (!path.isAbsolute(ploinkyBin)) problems.push('SMOKE_PLOINKY_BIN must be the absolute bin/ploinky of the checkout that created the deployment');
  else {
    try { fs.accessSync(ploinkyBin, fs.constants.X_OK); } catch { problems.push(`SMOKE_PLOINKY_BIN (${ploinkyBin}) is not executable`); }
  }
  if (String(env.SMOKE_PLOINKY_BOX_CONTAINER || '').trim()) problems.push('unset SMOKE_PLOINKY_BOX_CONTAINER: the DGX Spark suite derives the Box from SMOKE_WORKSPACE_ROOT');
  if (process.platform !== 'linux' || os.arch() !== 'arm64') problems.push(`the DGX Spark suite runs on the Spark itself (linux/arm64), not ${process.platform}/${os.arch()}`);
  if (problems.length) throw new Error(`The DGX Spark suite cannot run: ${problems.join('; ')}.`);
  return Object.freeze({ workspaceRoot: path.resolve(workspaceRoot), ploinkyBin });
}

// The environment of every ploinky call: the workspace pinned through PLOINKY_WORKSPACE_ROOT (which Ploinky prefers over
// the cwd, and which an operator shell may inherit for another workspace), and no inherited hardware-limits gate request.
// Only `overrides` (spec 95's explicit PLOINKY_BOX_HARDWARE_LIMITS=on) may add one.
export function ploinkyEnvironment(workspaceRoot, overrides = {}, base = process.env) {
  const env = { ...base };
  delete env.PLOINKY_BOX_HARDWARE_LIMITS;
  env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
  return { ...env, ...overrides };
}

export function createPloinky({ workspaceRoot, ploinkyBin, run = runCommand }) {
  return async function ploinky(args, { timeoutMs = 120_000, env } = {}) {
    const result = await run(ploinkyBin, args, { cwd: workspaceRoot, timeoutMs, env: ploinkyEnvironment(workspaceRoot, env) });
    return { ...result, args };
  };
}

// "Key: value" lines of `ploinky gpu status` and `ploinky limits status`.
export function parseKeyLines(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const found = /^([A-Za-z][A-Za-z ]*[A-Za-z]):\s*(.*)$/.exec(line.trim());
    if (found && !(found[1] in out)) out[found[1]] = found[2].trim();
  }
  return out;
}

export function parseGpuStatus(text) {
  const keys = parseKeyLines(text);
  const agents = String(keys['GPU agents'] || '').split(',').map((part) => part.trim()).filter((part) => part && part !== 'none')
    .map((entry) => { const found = /^(\S+)(?:\s+\(([^)]*)\))?$/.exec(entry); return found ? { ref: found[1], source: found[2] || '' } : { ref: entry, source: '' }; });
  const box = /^(\S+);\s*GPU wiring\s+(\S+)(?:\s+([a-f0-9]{12}))?/.exec(String(keys.Box || ''));
  const desired = /^(\S+)(?:\s+([a-f0-9]{12}))?/.exec(String(keys['Desired GPU wiring'] || ''));
  return {
    instance: keys['Workspace identity'] || '',
    grant: keys['GPU grant'] || '',
    agents,
    manifestDeclarations: String(keys['Manifest GPU declarations'] || '').split(',').map((part) => part.trim()).filter(Boolean),
    hostGpu: keys['Host GPU'] || '',
    boxState: box ? box[1] : '',
    wiring: box ? box[2] : '',
    wiringFingerprint: box ? box[3] || '' : '',
    desiredWiring: desired ? desired[1] : '',
    desiredFingerprint: desired ? desired[2] || '' : '',
    raw: keys,
  };
}

export function parseLimitsStatus(text) {
  const keys = parseKeyLines(text);
  const gate = /^(on|off)\b/.exec(String(keys['Hardware limits'] || ''));
  return { instance: keys['Workspace identity'] || '', gate: gate ? gate[1] : '', gateText: keys['Hardware limits'] || '', hostDelegation: keys['Host delegation'] || '', box: keys.Box || '', raw: keys };
}

// ---------------------------------------------------------------------------
// Box resolution and inspection

const BOX_INSTANCE = /^ploinky-box-[a-z0-9-]+-[a-f0-9]{12}$/;

// The 12-hex path hash Ploinky puts in the Box instance name and label (ploinky-box/identity.mjs workspacePathHash).
export const workspacePathHash = (workspaceRoot) => crypto.createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 12);

// The exact owned Box of the workspace: the instance `ploinky gpu status` names must carry the path hash of
// SMOKE_WORKSPACE_ROOT in its name and label, run, and bind exactly that workspace (inspectBoxWorkspace).
export async function resolveBox({ ploinky, workspaceRoot, run = runCommand }) {
  if (!path.isAbsolute(String(workspaceRoot || ''))) throw new Error('resolveBox needs the absolute workspace root.');
  const pathHash = workspacePathHash(workspaceRoot);
  const status = await ploinky(['gpu', 'status'], { timeoutMs: 60_000 });
  const gpu = parseGpuStatus(checked(status, 'ploinky gpu status'));
  if (!BOX_INSTANCE.test(gpu.instance)) throw new Error(`ploinky gpu status named no exact workspace identity (${gpu.instance || 'none'}).`);
  const inspected = checkedJson(await run('podman', ['container', 'inspect', gpu.instance], { timeoutMs: 20_000 }), 'Box inspection');
  if (!Array.isArray(inspected) || inspected.length !== 1) throw new Error('The Box inspection did not return exactly one container.');
  const record = inspected[0];
  const labels = record?.Config?.Labels || {};
  if (record?.State?.Running !== true) throw new Error(`The Box ${gpu.instance} is not running.`);
  if (!gpu.instance.endsWith(`-${pathHash}`) || labels['io.assistos.ploinky-box.role'] !== 'box' || labels['io.assistos.ploinky-box.path-hash'] !== pathHash) {
    throw new Error(`The container ${gpu.instance} is not the Box of ${workspaceRoot} (path hash ${pathHash}).`);
  }
  const mount = inspectBoxWorkspace(record);
  if (mount.source !== workspaceRoot) throw new Error(`The Box ${gpu.instance} binds ${mount.source}, not ${workspaceRoot}.`);
  return Object.freeze({ name: gpu.instance, id: record.Id, imageId: record.Image, startedAt: record.State.StartedAt, labels, record, gpu });
}

export function boxPublications(record) {
  const bindings = record?.HostConfig?.PortBindings || {};
  return Object.entries(bindings).flatMap(([port, hosts]) => (hosts || []).map((host) => `${host.HostIp || ''}:${host.HostPort}->${port}`)).sort();
}

// The --device values of a podman create command (`--device X` or `--device=X`), without host:container suffixes.
export function createCommandDevices(argv) {
  const out = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < list.length; index += 1) {
    const arg = String(list[index]);
    if (arg === '--device' && index + 1 < list.length) out.push(String(list[index + 1]).split(':')[0]);
    else if (arg.startsWith('--device=')) out.push(arg.slice('--device='.length).split(':')[0]);
  }
  return out;
}

export function createCommandFlags(argv, flag) {
  const out = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < list.length; index += 1) {
    const arg = String(list[index]);
    if (arg === flag && index + 1 < list.length) out.push(String(list[index + 1]));
    else if (arg.startsWith(`${flag}=`)) out.push(arg.slice(flag.length + 1));
  }
  return out;
}

// Podman inside the Box prints "Could not locate device" warnings for CDI-mapped nodes on stderr; only stdout is JSON.
export async function inspectNested({ run = runCommand, boxName, names }) {
  if (!names.length) return [];
  for (const name of names) validateBoxName(name);
  const inspected = checkedJson(await run('podman', [...nestedArgs(boxName), 'container', 'inspect', ...names], { timeoutMs: 60_000 }), 'Nested container inspection');
  if (!Array.isArray(inspected) || inspected.length !== names.length) throw new Error('Nested inspection did not return one record per container.');
  return inspected;
}

export async function listNested({ run = runCommand, boxName }) {
  const text = checked(await run('podman', [...nestedArgs(boxName), 'container', 'ls', '--all', '--format', '{{.Names}}\t{{.State}}'], { timeoutMs: 30_000 }), 'Nested container listing');
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name, state] = line.split('\t');
    return { name, state: String(state || '').toLowerCase() };
  }).filter((entry) => entry.name.startsWith(NESTED_PREFIX)).sort((left, right) => left.name.localeCompare(right.name));
}

// The nested container of one manifest agent (`ploinky_<repo>_<agent>_<workspace>_<hash>`), exactly one.
export function nestedNameOf(entries, ref) {
  const [repo, agent] = String(ref).split('/');
  const matches = entries.filter((entry) => entry.name.startsWith(`${NESTED_PREFIX}${repo}_${agent}_`));
  if (matches.length !== 1) throw new Error(`Expected exactly one nested container for ${ref}; found ${matches.length}.`);
  return matches[0].name;
}

export async function execNested({ run = runCommand, boxName, name, argv, timeoutMs = 60_000 }) {
  validateBoxName(name);
  return run('podman', [...nestedArgs(boxName), 'container', 'exec', name, ...argv], { timeoutMs });
}

export async function execBox({ run = runCommand, boxName, argv, timeoutMs = 30_000 }) {
  return run('podman', [...coreArgs(boxName), ...argv], { timeoutMs });
}

// Polls until every nested container of the workspace runs and their count stops changing for `settleMs`.
export async function waitForGraph({ run = runCommand, boxName, minimum, timeoutMs = 20 * 60_000, settleMs = 30_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  let last = '';
  for (;;) {
    let entries = [];
    try { entries = await listNested({ run, boxName }); } catch { entries = []; }
    const running = entries.filter((entry) => entry.state === 'running');
    const key = running.map((entry) => entry.name).join(',');
    const complete = running.length >= minimum && running.length === entries.length;
    if (complete && key === last) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= settleMs) return running;
    } else stableSince = 0;
    last = key;
    if (Date.now() >= deadline) throw new Error(`The workspace graph did not settle with ${minimum} running containers (${running.length}/${entries.length} running).`);
    await sleep(5000);
  }
}

// ---------------------------------------------------------------------------
// Host facts

export function parseCsvRow(text) {
  const rows = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return rows.map((row) => row.split(',').map((part) => part.trim()));
}

export const GPU_QUERY_FIELDS = Object.freeze(['name', 'pci.device_id', 'compute_cap', 'addressing_mode', 'driver_version', 'memory.total', 'uuid']);

export function parseGpuQuery(text) {
  const rows = parseCsvRow(text);
  if (rows.length !== 1 || rows[0].length !== GPU_QUERY_FIELDS.length) throw new Error(`Expected one GPU row of ${GPU_QUERY_FIELDS.length} fields; got ${rows.length} rows.`);
  const [name, pciDeviceId, computeCapability, addressingMode, driverVersion, memoryTotal, uuid] = rows[0];
  return { name, pciDeviceId, computeCapability, addressingMode, driverVersion, memoryTotal, uuid };
}

export async function readHostGpu({ run = runCommand }) {
  return parseGpuQuery(checked(await run('nvidia-smi', [`--query-gpu=${GPU_QUERY_FIELDS.join(',')}`, '--format=csv,noheader'], { timeoutMs: 30_000 }), 'Host nvidia-smi query'));
}

export function parseComputeApps(text) {
  return parseCsvRow(text).filter((row) => row.length >= 3 && /^[0-9]+$/.test(row[0])).map(([pid, name, used]) => ({
    pid: Number(pid), name, usedMiB: /^[0-9]+/.test(used) ? Number(/^[0-9]+/.exec(used)[0]) : null,
  }));
}

export async function readComputeApps({ run = runCommand }) {
  return parseComputeApps(checked(await run('nvidia-smi', ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader'], { timeoutMs: 30_000 }), 'Host compute-process query'));
}

export function hostCgroupOf(pid, procRoot = '/proc') {
  try {
    const found = /^0::(\/.*)$/m.exec(fs.readFileSync(`${procRoot}/${pid}/cgroup`, 'utf8'));
    return found ? found[1] : '';
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    throw error;
  }
}

// GPU compute processes split into those of this Box (host cgroup inside libpod-<boxId>) and foreign ones.
export function classifyComputeApps(apps, boxId, cgroupOf = hostCgroupOf) {
  const owned = [];
  const foreign = [];
  for (const app of apps) {
    const cgroup = cgroupOf(app.pid);
    if (cgroup === null) continue; // exited between the query and the read
    (String(cgroup).includes(`libpod-${boxId}`) ? owned : foreign).push({ ...app, cgroup });
  }
  return { owned, foreign };
}

export function readMemTotalBytes(procRoot = '/proc') {
  const found = /^MemTotal:\s+([0-9]+) kB$/m.exec(fs.readFileSync(`${procRoot}/meminfo`, 'utf8'));
  if (!found) throw new Error('MemTotal is unreadable.');
  return Number(found[1]) * 1024;
}

// ---------------------------------------------------------------------------
// MCP tools through the Router, with the raw isError flag kept (callAgentToolViaRouter decodes it away)

export async function callTool(page, { agent = LOCAL_LLM_ROUTE, tool, args = {} }) {
  const reply = await page.evaluate(async ({ agent: route, tool: name, args: input }) => {
    const endpoint = `/${encodeURIComponent(route)}/mcp`;
    const proofResponse = await fetch(`/auth/token?agent=${encodeURIComponent(route)}`, { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } });
    const proof = (await proofResponse.json().catch(() => ({})))?.browserMutation;
    if (!proofResponse.ok || !proof?.csrfToken || proof.routeKey !== route) return { transport: `no browser mutation proof for ${endpoint} (HTTP ${proofResponse.status})` };
    const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'x-ploinky-browser-csrf-token': proof.csrfToken };
    const init = await fetch(endpoint, {
      method: 'POST', credentials: 'include', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 'dgx-init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'assistos-smoke-dgx', version: '1.0.0' } } }),
    });
    const initBody = await init.json().catch(() => ({}));
    const sessionId = init.headers.get('mcp-session-id');
    if (!init.ok || !sessionId || initBody.error) return { transport: `MCP initialize on ${endpoint} failed (HTTP ${init.status})` };
    const response = await fetch(endpoint, {
      method: 'POST', credentials: 'include',
      headers: { ...headers, 'mcp-session-id': sessionId, 'mcp-protocol-version': initBody.result?.protocolVersion || '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'dgx-tool', method: 'tools/call', params: { name, arguments: input } }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { transport: `MCP tool ${name} answered HTTP ${response.status}` };
    if (body.error) return { rpcError: String(body.error.message || body.error).slice(0, 2000) };
    const result = body.result || {};
    const blocks = Array.isArray(result.content) ? result.content : [];
    const json = blocks.find((block) => block?.type === 'json' && block.json && typeof block.json === 'object')?.json;
    const text = blocks.find((block) => block?.type === 'text' && typeof block.text === 'string')?.text;
    return { isError: result.isError === true, json: json ?? null, text: text ?? null };
  }, { agent, tool, args });
  if (reply.transport) throw new Error(reply.transport);
  let value = reply.json;
  if (value === null && typeof reply.text === 'string') { try { value = JSON.parse(reply.text); } catch { value = null; } }
  const failed = Boolean(reply.rpcError) || reply.isError || (value && value.ok === false);
  return { ok: !failed, value, text: String(reply.rpcError || reply.text || '').slice(0, 4000) };
}

export async function callToolOk(page, tool, args = {}) {
  const reply = await callTool(page, { tool, args });
  if (!reply.ok) throw new Error(`${tool} failed: ${reply.text.slice(0, 600)}`);
  return reply.value;
}

// The typed error code of a local-llm refusal: `admission_incompatible` and the like, from JSON or message text.
export function errorCodeOf(reply) {
  const fromValue = reply?.value?.code || reply?.value?.error?.code;
  if (typeof fromValue === 'string' && fromValue) return fromValue;
  const found = /\b((?:admission|budget|gpu|runner|model)_[a-z_]+)\b/.exec(String(reply?.text || ''));
  return found ? found[1] : '';
}

export async function waitForPhase(page, accept, { timeoutMs, intervalMs = 3000, label }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await callToolOk(page, 'local_llm_status', {});
    const phase = String(last.phase || 'idle');
    if (phase === 'error' || last.deployment?.phase === 'error') throw new Error(`local-llm reached error while waiting for ${label}: ${String(last.deployment?.error || '').slice(0, 400)}`);
    if (accept(last)) return last;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label} (phase ${phase}).`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function stopModelIfActive(page, { timeoutMs = 5 * 60_000 } = {}) {
  const status = await callToolOk(page, 'local_llm_status', {});
  if (!ACTIVE_PHASES.has(String(status.phase || 'idle'))) return status;
  await callToolOk(page, 'local_llm_stop', {});
  return waitForPhase(page, (value) => !ACTIVE_PHASES.has(String(value.phase || 'idle')), { timeoutMs, label: 'the model to stop' });
}

// Opens Explorer once per page. A second navigation while Explorer still loads its plugins aborts those requests, and
// the smoke fixture rightly counts every aborted request as a browser error.
export async function ensureExplorer(page) {
  const loaded = /\/explorer\//.test(page.url()) && await page.locator('#page_content').isVisible().catch(() => false)
    && await page.evaluate(() => Boolean(globalThis.webSkel && document.querySelector('#page_content')?.children.length)).catch(() => false);
  if (!loaded) await openExplorer(page);
}

// The Local LLMs dashboard through its toolbar button, as an administrator opens it. The expanded-modal fallback is
// fired without awaiting: its promise settles only when the modal closes.
export async function openLocalLlmDashboard(page, { timeout = 45_000 } = {}) {
  const button = page.locator('#localLlmToolButton');
  let via = 'toolbar-button';
  try {
    await button.waitFor({ state: 'visible', timeout: 15_000 });
    await button.click();
  } catch {
    via = 'expanded-modal';
    await page.evaluate(() => { globalThis.assistOS.UI.openExpandedModal({ mode: 'component', component: 'local-llm-dashboard', title: 'Local LLMs' }); });
  }
  // WebSkel also injects <style class="local-llm-dashboard">; only the div is the dashboard.
  const dashboard = page.locator('div.local-llm-dashboard');
  await dashboard.waitFor({ state: 'visible', timeout });
  return { dashboard, via };
}

// A fresh administrator page for afterAll restores, where the per-test page fixture is unavailable.
export async function withAdminPage(browser, baseURL, fn) {
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await openExplorer(page);
    return await fn(page);
  } finally {
    await context.close();
  }
}

// Runs every restore step, keeps going after a failure, and reports what failed.
export async function restoreSteps(steps) {
  const results = [];
  for (const [label, step] of steps) {
    try { results.push({ label, ok: true, detail: (await step()) ?? null }); } catch (error) { results.push({ label, ok: false, detail: String(error?.message || error).slice(0, 400) }); }
  }
  return results;
}

export const requestId = (label) => `dgx-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------
// Unified admission arithmetic (local-llm profiles.mjs poolVerdict, ploinkyBudget.mjs effectiveMemory)
//
// local-llm's unifiedVerdict sizes the pool as the capped total min(Pt, B), where Pt is the host's physical total and B the
// agent's budget. A Run fits only when need <= B (U2) and need <= B - the agent's current use (U4). The host reserve and
// floor apply to the host's physical memory Pt, not to the budget.

// The smallest percentage whose budget holds the need, the agent's current use and a margin.
export function unifiedFitPercent({ needBytes, envelopeBytes, usedBytes = 0, marginBytes = 2 * GIB }) {
  const percent = Math.ceil(((needBytes + usedBytes + marginBytes) / envelopeBytes) * 100);
  if (percent > 100) throw new Error(`The unified need ${needBytes} B cannot fit any RAM budget of this ${envelopeBytes} B envelope.`);
  return percent;
}

// The largest percentage whose budget is at least 1 GiB below the need: a certain U2 refusal.
export function unifiedRefusePercent({ needBytes, envelopeBytes, marginBytes = GIB }) {
  const percent = Math.floor(((needBytes - marginBytes) / envelopeBytes) * 100);
  if (percent < 1) throw new Error('No RAM percentage refuses the model below its unified need.');
  return percent;
}

// The pre-change rule, where the physical host reserve and floor were charged inside the budget. Kept only so spec 95
// can show that the current fit percentage is below it, and for its unit test. Do not use it to size a budget.
export function reserveInBudgetFitPercent({ needBytes, envelopeBytes, hostReserveBytes = UNIFIED_HOST_RESERVE_BYTES, floorBytes = UNIFIED_FLOOR_BYTES, usedBytes = 0, marginBytes = 2 * GIB }) {
  const required = Math.max(needBytes + hostReserveBytes, needBytes + floorBytes + usedBytes) + marginBytes;
  const percent = Math.ceil((required / envelopeBytes) * 100);
  if (percent > 100) throw new Error(`The unified need ${needBytes} B cannot fit any RAM budget of this ${envelopeBytes} B envelope.`);
  return percent;
}

// ---------------------------------------------------------------------------
// Evidence

export function writeEvidence(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (/(?:csrf|cookie|password|authorization|bearer)\s*["':=]/i.test(text)) throw new Error(`Refusing to write ${name}: it looks like it holds a credential.`);
  fs.writeFileSync(path.join(dir, name), text);
  return path.join(dir, name);
}
