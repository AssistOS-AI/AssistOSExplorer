// Helpers of the local-llm model registries live E2E (spec 98) and its runner: the environment check, the Box lookup,
// the base-URL-to-Box proof, the failing-tool error code, the A32 key probe, the final-restore decision for the registry
// state files and the judgement of Playwright's JSON report. The functions take their commands and environment as
// arguments, so lib/local-llm-registries.test.mjs runs them with stubs, on any host.
import fs from 'node:fs';
import path from 'node:path';

import { boxPublications, resolveBox, runCommand, workspacePathHash } from './dgx-spark.mjs';
import { inspectBoxWorkspace } from './box-workspace.mjs';
import { checked, checkedJson } from './hardware-limits-evidence.mjs';
import { judgeResults } from '../scripts/run-dgx-spark-e2e.mjs';

// The five groups of spec 98 in run order, and every test of each. The spec declares its tests from this list.
export const SPEC98_INVENTORY = Object.freeze([
  ['credentials', 'A32: credential storage is available in the Box agent'],
  ['credentials', 'credentials: set the oci-dummy credential'],
  ['credentials', 'credentials: the credential survives a local-llm restart (N3)'],
  ['credentials', 'credentials: leak scan'],
  ['negative controls', 'negative controls: ghcr KitOps modelkit is refused as unsupported_artifact'],
  ['negative controls', 'negative controls: dockerhub library/ubuntu image is refused as unsupported_artifact'],
  ['negative controls', 'negative controls: modelscope unknown revision gives not_found'],
  ['negative controls', 'negative controls: loopback registry gives address_refused'],
  ['GGUF', 'GGUF: dockerhub CNCF ai/smollm2:135m-q4_K_M runs and answers'],
  ['GGUF', 'GGUF: dockerhub legacy ai/smollm2:latest runs and answers'],
  ['GGUF', 'GGUF: modelscope Qwen2.5-0.5B-Instruct-GGUF runs and answers'],
  ['GGUF', 'GGUF: self-registered Hugging Face Qwen2.5-0.5B-Instruct-GGUF runs and answers'],
  ['snapshot', 'snapshot: the profile is dedicated and vLLM is installed at the pinned version'],
  ['snapshot', 'snapshot: dockerhub ai/smollm2:135m-safetensors runs on vLLM and answers'],
  ['snapshot', 'snapshot: modelscope Qwen2.5-0.5B-Instruct runs on vLLM and answers'],
  ['final restore', 'final restore: registry state matches the initial record'],
].map(([group, title]) => Object.freeze({ group, title })));

const A32_TITLE = SPEC98_INVENTORY[0].title;
const CREDENTIAL_TITLES = SPEC98_INVENTORY.filter((entry) => entry.group === 'credentials').map((entry) => entry.title);
const inventoryKey = (group, title) => `${group}\u0000${title}`;

// ---------------------------------------------------------------------------
// Environment, Box and base URL

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);
const BOX_INSTANCE = /^ploinky-box-[a-z0-9-]+-[a-f0-9]{12}$/;

// ploinky-box/identity.mjs workspaceSlug.
function workspaceSlug(workspaceRoot) {
  return path.basename(workspaceRoot).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
    .replace(/-+$/g, '') || 'box';
}

function parseUrl(value) {
  try { return new URL(value); } catch { return null; }
}

// `platform` is a seam for the unit tests; the live spec always runs on the process platform.
export function requireLocalLlmRegistriesEnvironment(env = process.env, platform = process.platform) {
  const problems = [];
  if (platform !== 'linux') problems.push(`the registries suite runs on the apparatus (linux), not ${platform}`);
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
  if (String(env.SMOKE_PLOINKY_BOX_CONTAINER || '').trim()) problems.push('unset SMOKE_PLOINKY_BOX_CONTAINER: the registries suite derives the Box from SMOKE_WORKSPACE_ROOT');
  const base = parseUrl(String(env.SMOKE_BASE_URL || '').trim());
  if (!base) problems.push('SMOKE_BASE_URL must be the Router URL, such as http://localhost:18080');
  else if (base.protocol !== 'http:') problems.push(`SMOKE_BASE_URL must use http:, not ${base.protocol}`);
  else if (!LOOPBACK_HOSTS.has(base.hostname) || !base.port) problems.push('SMOKE_BASE_URL must be on host localhost or 127.0.0.1 with an explicit port');
  const boxBase = String(env.SMOKE_BOX_BASE_URL || '').trim();
  if (boxBase) {
    const parsed = parseUrl(boxBase);
    if (!parsed || !base || parsed.origin !== base.origin) problems.push('SMOKE_BOX_BASE_URL must equal the origin of SMOKE_BASE_URL when it is set');
  }
  if (problems.length) throw new Error(`The local-llm registries suite cannot run: ${problems.join('; ')}.`);
  return Object.freeze({ workspaceRoot: path.resolve(workspaceRoot), ploinkyBin, baseURL: base.origin });
}

// The one running Box of the workspace, found by its role and path-hash labels instead of `ploinky gpu status`.
export async function boxOf({ workspaceRoot, run = runCommand }) {
  if (!path.isAbsolute(String(workspaceRoot || ''))) throw new Error('boxOf needs the absolute workspace root.');
  const pathHash = workspacePathHash(workspaceRoot);
  const listed = checked(await run('podman', [
    'ps', '-a',
    '--filter', 'label=io.assistos.ploinky-box.role=box',
    '--filter', `label=io.assistos.ploinky-box.path-hash=${pathHash}`,
    '--format', '{{.Names}}',
  ], { timeoutMs: 20_000 }), 'Box listing');
  const names = listed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (names.length !== 1) throw new Error(`Expected exactly one Box for ${workspaceRoot} (path hash ${pathHash}); podman listed ${names.length}.`);
  const [name] = names;
  if (!BOX_INSTANCE.test(name) || !name.endsWith(`-${pathHash}`) || name !== `ploinky-box-${workspaceSlug(workspaceRoot)}-${pathHash}`) {
    throw new Error(`The container ${name} is not the Box name of ${workspaceRoot} (path hash ${pathHash}).`);
  }
  const inspected = checkedJson(await run('podman', ['container', 'inspect', name], { timeoutMs: 20_000 }), 'Box inspection');
  if (!Array.isArray(inspected) || inspected.length !== 1) throw new Error('The Box inspection did not return exactly one container.');
  const record = inspected[0];
  const labels = record?.Config?.Labels || {};
  if (record?.State?.Running !== true) throw new Error(`The Box ${name} is not running.`);
  if (labels['io.assistos.ploinky-box.role'] !== 'box' || labels['io.assistos.ploinky-box.path-hash'] !== pathHash) {
    throw new Error(`The container ${name} is not the Box of ${workspaceRoot} (path hash ${pathHash}).`);
  }
  const mount = inspectBoxWorkspace(record);
  if (mount.source !== workspaceRoot) throw new Error(`The Box ${name} binds ${mount.source}, not ${workspaceRoot}.`);
  return Object.freeze({ name, id: record.Id, imageId: record.Image, startedAt: record.State.StartedAt, labels, record });
}

// `ploinky gpu status` when it names a Box identity (resolveBox), the Box labels otherwise (boxOf, for a host with no GPU).
export async function locateBox({ ploinky, workspaceRoot, run = runCommand }) {
  const status = await ploinky(['gpu', 'status'], { timeoutMs: 60_000 });
  const identity = status && status.status === 0 ? /^Workspace identity:\s*(\S+)/m.exec(String(status.stdout || ''))?.[1] : '';
  if (identity && BOX_INSTANCE.test(identity)) {
    return Object.freeze({ ...(await resolveBox({ ploinky, workspaceRoot, run })), resolvedBy: 'ploinky gpu status' });
  }
  return Object.freeze({ ...(await boxOf({ workspaceRoot, run })), resolvedBy: 'podman box labels' });
}

// SMOKE_BASE_URL must reach this Box: its port 8080 is published once, on 127.0.0.1, at the URL's port.
export function assertBaseUrlBindsBox({ baseURL, box }) {
  const port = new URL(baseURL).port;
  const expected = `127.0.0.1:${port}->8080/tcp`;
  const bindings = box?.record?.HostConfig?.PortBindings?.['8080/tcp'];
  const list = Array.isArray(bindings) ? bindings : [];
  const current = boxPublications(box?.record).filter((entry) => entry.endsWith('->8080/tcp'));
  const ok = list.length === 1 && list[0].HostIp === '127.0.0.1' && String(list[0].HostPort) === port;
  const result = { expected, current, ok };
  if (!ok) throw new Error(`SMOKE_BASE_URL ${baseURL} does not reach the Box ${box?.name}: expected ${expected}, the Box publishes ${current.join(', ') || 'nothing'} for 8080/tcp.`);
  return result;
}

// ---------------------------------------------------------------------------
// Tool errors, the A32 key probe and the final restore of the registry state files

// A failing tool reaches callTool as text with value === null: `MCP error <n>: <code>[: <message>]`.
const TOOL_ERROR = /^MCP error -?\d+: ([a-z][a-z0-9_]*)(?:: |$)/;
export function toolErrorCode(reply) {
  if (!reply || reply.ok !== false || typeof reply.text !== 'string') return '';
  return TOOL_ERROR.exec(reply.text)?.[1] || '';
}

// The exit codes of the A32 key probe: 0 usable, 3 absent, 4 malformed.
export function classifyKeyProbe(exitCode) {
  if (exitCode === 0) return 'valid';
  if (exitCode === 3) return 'absent';
  if (exitCode === 4) return 'malformed';
  return 'unknown';
}

// One of /data/state/registries.json and registry-credentials.json at the end of the run. `currentExit` is the exit of
// `test -e` on it, `removedExit` that of the same check after the run removed it by exact path.
export function stateFileRestoreStep({ initiallyPresent, currentExit, removedExit }) {
  if (initiallyPresent) {
    if (currentExit === 0) return { action: 'kept', ok: true, detail: 'present, as in the initial record' };
    if (currentExit === 1) return { action: 'missing', ok: false, detail: 'initially present file is gone' };
    return { action: 'unknown', ok: false, detail: `test -e exited ${currentExit}` };
  }
  if (currentExit === 1) return { action: 'absent', ok: true, detail: 'absent, nothing to remove' };
  if (currentExit === 0) {
    if (removedExit === 1) return { action: 'remove', ok: true, detail: 'created by the run, removed by exact path and absent again' };
    return { action: 'remove', ok: false, detail: removedExit === undefined ? 'created by the run: remove it by exact path, then check again' : `after removal test -e exited ${removedExit}, not 1` };
  }
  return { action: 'unknown', ok: false, detail: `test -e exited ${currentExit}` };
}

// ---------------------------------------------------------------------------
// The verdict of a run

function collectTests(report) {
  const found = [];
  const visit = (suite, group) => {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || [spec]) {
        const annotations = [...(test.annotations || []), ...(test.results || []).flatMap((result) => result.annotations || [])];
        found.push({ group, title: spec.title, status: test.status, annotations, results: test.results || [] });
      }
    }
    for (const child of suite.suites || []) visit(child, child.title);
  };
  for (const file of report.suites || []) visit(file, '');
  return found;
}

function inventoryProblems(tests) {
  const problems = [];
  const counts = new Map();
  for (const test of tests) counts.set(inventoryKey(test.group, test.title), (counts.get(inventoryKey(test.group, test.title)) || 0) + 1);
  for (const { group, title } of SPEC98_INVENTORY) {
    const count = counts.get(inventoryKey(group, title)) || 0;
    if (count === 0) problems.push(`missing test "${title}" (${group})`);
    if (count > 1) problems.push(`duplicate test "${title}" (${group}) x${count}`);
  }
  const known = new Set(SPEC98_INVENTORY.map(({ group, title }) => inventoryKey(group, title)));
  for (const test of tests) if (!known.has(inventoryKey(test.group, test.title))) problems.push(`extra test "${test.title}" (${test.group || 'no group'})`);
  return problems;
}

function statsOf(report) {
  const stats = report?.stats || {};
  return Object.fromEntries(['expected', 'unexpected', 'flaky', 'skipped', 'interrupted'].filter((key) => key in stats).map((key) => [key, stats[key]]));
}

// The first step that decides wins: failed, partial, passed, qb-a32-only, failed.
export function judgeRegistriesResults(report, { exitStatus, signal, partialFiles = [], a32 = null } = {}) {
  const keyProbe = a32 && typeof a32 === 'object' ? classifyKeyProbe(a32.keyProbeExit) : '';
  const stats = statsOf(report);
  const outcome = (kase, problems) => ({ ok: kase === 'passed', case: kase, problems, stats, keyProbe });
  const hard = [];
  if (!report || typeof report !== 'object') hard.push('the Playwright JSON report is missing');
  else if (Array.isArray(report.errors) && report.errors.length) hard.push(`the report holds ${report.errors.length} global or worker error(s)`);
  if (signal) hard.push(`Playwright was killed by ${signal}`);
  if (exitStatus !== 0 && exitStatus !== 1) hard.push(`Playwright exited ${exitStatus}`);
  const tests = report && typeof report === 'object' ? collectTests(report) : [];
  if (report && typeof report === 'object') hard.push(...inventoryProblems(tests));
  if (hard.length) return outcome('failed', hard);

  const partials = tests.flatMap((test) => test.annotations.filter((note) => note?.type === 'partial').map((note) => `${test.title}: ${note.description || 'partial'}`));
  if (partials.length || (Array.isArray(partialFiles) && partialFiles.length)) {
    return outcome('partial', [...partials, ...(partialFiles.length ? [`${partialFiles.length} partial-snapshot.json file(s)`] : [])]);
  }

  const dgx = judgeResults(report);
  if (dgx.ok && exitStatus === 0 && tests.every((test) => test.status === 'expected')) return outcome('passed', []);

  const byTitle = new Map(tests.map((test) => [test.title, test]));
  const a32Test = byTitle.get(A32_TITLE);
  const unexpected = tests.filter((test) => test.status === 'unexpected');
  const others = tests.filter((test) => test.group !== 'credentials');
  const interrupted = tests.some((test) => test.results.some((result) => result.status === 'interrupted'));
  const qb = exitStatus === 1
    && a32Test?.status === 'unexpected' && unexpected.length === 1
    && CREDENTIAL_TITLES.filter((title) => title !== A32_TITLE).every((title) => byTitle.get(title)?.status === 'skipped')
    && others.every((test) => test.status === 'expected')
    && !interrupted && !stats.flaky && !stats.interrupted
    && (keyProbe === 'absent' || keyProbe === 'malformed');
  if (qb) return outcome('qb-a32-only', [`A32 failed and the agent key is ${keyProbe}`]);

  const problems = [...dgx.problems];
  if (a32Test?.status === 'unexpected' && keyProbe === 'valid') problems.push('A32 failed although the agent key is valid: a candidate defect, not Q-B');
  if (a32Test?.status === 'unexpected' && keyProbe === 'unknown') problems.push('A32 failed and the key probe is unknown: unattributed');
  for (const test of unexpected) problems.push(`failed: ${test.title}`);
  if (!problems.length) problems.push('the run is not a pass and not the Q-B shape');
  return outcome('failed', problems);
}
