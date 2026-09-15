import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { collectLiveBoxEvidence, parseLocalScreenBaseUrl } from './live-box.mjs';

const CONTAINER_ID = /^[a-f0-9]{64}$/;
const EXEC_ID = /^[a-f0-9]{64}$/;
const CONTAINER_USER = /^(?:[0-9]+|[A-Za-z_][A-Za-z0-9_-]*)(?::(?:[0-9]+|[A-Za-z_][A-Za-z0-9_-]*))?$/;
const CONTAINER_HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const EVENT_CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_AGENT_PROCESS_ROWS = 4096;
const AGENT_PROCESS_SNAPSHOT_SOURCE = String.raw`
import fs from 'node:fs';

const MAX_PROC_TEXT_BYTES = 64 * 1024;
const rootPid = Number.parseInt(String(process.argv[1] || ''), 10);
if (!Number.isSafeInteger(rootPid) || rootPid <= 1) {
  throw new Error('invalid exact container init PID');
}

const entries = fs.readdirSync('/proc').filter((entry) => /^[1-9][0-9]*$/.test(entry));
if (entries.length > 8192) throw new Error('outer process inventory exceeded its bound');

function readBounded(file) {
  const value = fs.readFileSync(file);
  if (value.length > MAX_PROC_TEXT_BYTES) throw new Error('proc evidence exceeded its bound');
  return value;
}

function readNamespace(pid) {
  const value = fs.readlinkSync('/proc/' + pid + '/ns/pid');
  if (!/^pid:\[[1-9][0-9]*\]$/.test(value)) throw new Error('malformed PID namespace');
  return value;
}

function readStat(pid) {
  const stat = readBounded('/proc/' + pid + '/stat').toString('utf8');
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open <= 0 || close <= open || Number(stat.slice(0, open).trim()) !== pid) {
    throw new Error('malformed proc stat');
  }
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const startToken = fields[19] || '';
  if (fields.length < 20 || !/^[A-Z]$/.test(fields[0] || '')
      || !Number.isSafeInteger(ppid) || ppid < 0
      || !/^[1-9][0-9]*$/.test(startToken)) {
    throw new Error('invalid proc identity');
  }
  return { pid, ppid, state: fields[0], startToken, comm: stat.slice(open + 1, close) };
}

function readStableProcess(pid) {
  const namespaceBefore = readNamespace(pid);
  const statBefore = readStat(pid);
  const cmdlineBefore = readBounded('/proc/' + pid + '/cmdline');
  const statMiddle = readStat(pid);
  const cmdlineAfter = readBounded('/proc/' + pid + '/cmdline');
  const statAfter = readStat(pid);
  const namespaceAfter = readNamespace(pid);
  if (namespaceBefore !== namespaceAfter
      || statBefore.startToken !== statMiddle.startToken
      || statMiddle.startToken !== statAfter.startToken
      || statBefore.ppid !== statMiddle.ppid
      || statMiddle.ppid !== statAfter.ppid
      || !cmdlineBefore.equals(cmdlineAfter)
      || statAfter.state === 'Z') {
    throw new Error('process identity changed during snapshot');
  }
  if (cmdlineAfter.length > 0 && cmdlineAfter.at(-1) !== 0) {
    throw new Error('malformed proc cmdline');
  }
  const args = cmdlineAfter.toString('utf8').split('\0').filter(Boolean).join(' ')
    || '[' + statAfter.comm + ']';
  return {
    pid,
    ppid: statAfter.ppid,
    startToken: statAfter.startToken,
    pidNamespace: namespaceAfter,
    args,
  };
}

const containerInitBefore = readStableProcess(rootPid);
const rows = [];
for (const entry of entries) {
  const pid = Number.parseInt(entry, 10);
  try {
    if (readNamespace(pid) !== containerInitBefore.pidNamespace) continue;
    const row = readStableProcess(pid);
    if (row.pidNamespace === containerInitBefore.pidNamespace) rows.push(row);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') continue;
    throw error;
  }
}
if (rows.length < 1 || rows.length > 4096) throw new Error('PID namespace row count is invalid');
const containerInitAfter = readStableProcess(rootPid);
if (containerInitAfter.startToken !== containerInitBefore.startToken
    || containerInitAfter.pidNamespace !== containerInitBefore.pidNamespace) {
  throw new Error('container init changed during PID namespace snapshot');
}
process.stdout.write(JSON.stringify({
  containerInit: {
    pid: rootPid,
    startToken: containerInitAfter.startToken,
    pidNamespace: containerInitAfter.pidNamespace,
  },
  rows,
}));
`;
const LABELS = Object.freeze({
  managed: 'io.assistos.ploinky.managed',
  resource: 'io.assistos.ploinky.resource',
  schema: 'io.assistos.ploinky.network-schema',
  workspace: 'io.assistos.ploinky.workspace',
  contract: 'io.assistos.ploinky.network-contract',
  instanceId: 'io.assistos.ploinky.instance-id',
  enableGeneration: 'io.assistos.ploinky.enable-generation',
});

function exactObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}

function exactText(value, name) {
  const text = typeof value === 'string' && value === value.trim() ? value : '';
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function run(command, args, { json = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowFailure) {
      return {
        ok: false,
        status: result.status,
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || ''),
      };
    }
    throw new Error(`${command} failed with exit ${result.status ?? 'unknown'}.`);
  }
  if (!json) return String(result.stdout || '');
  try {
    return JSON.parse(String(result.stdout || ''));
  } catch (_) {
    throw new Error(`${command} returned malformed JSON.`);
  }
}

function readRegistry(workspaceRoot) {
  const registryPath = path.join(workspaceRoot, '.ploinky', 'agents.json');
  const registry = exactObject(JSON.parse(fs.readFileSync(registryPath, 'utf8')), 'agent registry');
  return Object.entries(registry)
    .filter(([key, value]) => key !== '_config' && value?.type === 'agent')
    .map(([containerName, record]) => ({ containerName, record }));
}

function exactNotFoundFailure(output, containerId) {
  if (output?.ok !== false || output.status !== 125 || !CONTAINER_ID.test(containerId)) return false;
  const exactId = containerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^(?:error:\\s*)?(?:no container with name or id ["']?${exactId}["']? found|no such container:?\\s+["']?${exactId}["']?|container ["']?${exactId}["']? does not exist)\\.?$`,
    'i',
  ).test(String(output.stderr || '').trim());
}

export function inspectNestedContainer(outerContainerId, containerId, command = run) {
  const output = command('podman', [
    'exec', outerContainerId,
    '/usr/bin/podman', 'container', 'inspect', containerId,
  ], { json: true, allowFailure: true });
  if (output?.ok === false) {
    if (exactNotFoundFailure(output, containerId)) return null;
    throw new Error(`Nested agent inspection failed closed with exit ${output.status ?? 'unknown'}.`);
  }
  if (!Array.isArray(output) || output.length !== 1 || output[0]?.Id !== containerId) {
    throw new Error('Nested agent inspection did not return the exact immutable container ID.');
  }
  return output[0];
}

function normalizeDestination(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) return '';
  if (!path.posix.isAbsolute(value) || value.startsWith('//')) return '';
  return path.posix.normalize(value).replace(/\/$/, '') || '/';
}

function segmentContains(root, candidate, separator = path.sep) {
  if (root === separator) return candidate.startsWith(separator);
  return candidate === root || candidate.startsWith(`${root}${separator}`);
}

function sourceOnHost(source, workspaceRoot) {
  const normalized = normalizeDestination(source);
  if (!normalized || !segmentContains('/workspace', normalized, '/')) return null;
  const suffix = path.posix.relative('/workspace', normalized);
  const candidate = path.resolve(workspaceRoot, ...suffix.split('/').filter(Boolean));
  const relative = path.relative(workspaceRoot, candidate);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  try {
    const real = fs.realpathSync(candidate);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch (_) {
    return null;
  }
}

function projectMount(raw, workspaceRoot) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const destination = normalizeDestination(raw.Destination ?? raw.destination);
  const type = String(raw.Type ?? raw.type ?? '').trim().toLowerCase();
  const source = String(raw.Source ?? raw.source ?? '');
  const rw = raw.RW ?? raw.rw;
  if (!destination || !type || typeof rw !== 'boolean') return null;
  return {
    type,
    source,
    sourceReal: type === 'bind' ? sourceOnHost(source, workspaceRoot) : null,
    destination,
    rw,
  };
}

function mappedDestination(sourceReal, destination, selectedReal) {
  if (!sourceReal || !segmentContains(sourceReal, selectedReal)) return '';
  const relative = path.relative(sourceReal, selectedReal);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return '';
  const translated = path.posix.resolve(destination, ...relative.split(path.sep).filter(Boolean));
  return segmentContains(destination, translated, '/') ? translated : '';
}

export function independentlyTranslateMount(selectedDirectory, rawMounts, workspaceRoot) {
  const selectedReal = fs.realpathSync(selectedDirectory);
  if (!Array.isArray(rawMounts)) return null;
  const mounts = rawMounts.map((mount) => projectMount(mount, workspaceRoot));
  if (mounts.some((mount) => mount === null)) return null;
  const candidates = mounts
    .filter((mount) => mount.type === 'bind' && mount.sourceReal)
    .map((mount) => ({
      mount,
      translated: mappedDestination(mount.sourceReal, mount.destination, selectedReal),
    }))
    .filter((candidate) => candidate.translated);
  if (!candidates.length) return null;
  const longestSource = Math.max(...candidates.map(({ mount }) => mount.sourceReal.length));
  const strongest = candidates.filter(({ mount }) => mount.sourceReal.length === longestSource);
  const destinations = new Set(strongest.map(({ translated }) => translated));
  if (destinations.size !== 1) return null;
  const translatedCwd = strongest[0].translated;
  const covering = mounts.filter((mount) => segmentContains(mount.destination, translatedCwd, '/'));
  const longestDestination = Math.max(...covering.map((mount) => mount.destination.length));
  const effective = covering.filter((mount) => mount.destination.length === longestDestination);
  if (!effective.length || effective.some((mount) => mount.type !== 'bind' || !mount.sourceReal)) return null;
  for (const mount of effective) {
    if (mappedDestination(mount.sourceReal, mount.destination, selectedReal) !== translatedCwd) return null;
  }
  const access = new Set(effective.map((mount) => mount.rw ? 'rw' : 'ro'));
  if (access.size !== 1) return null;
  return Object.freeze({ translatedCwd, access: [...access][0] });
}

function exactRuntimeRecord(containerName, record) {
  const containerId = String(record?.containerId || '').trim().toLowerCase();
  if (record?.runtime !== 'podman' || !CONTAINER_ID.test(containerId)) return null;
  return {
    runtime: 'podman',
    containerName: exactText(containerName, 'agent registry container name'),
    containerId,
    instanceId: exactText(record.instanceId, 'agent instance ID'),
    enableGeneration: exactText(record.enableGeneration, 'agent enable generation'),
    repoName: exactText(record.repoName, 'agent repository name'),
    agentName: exactText(record.agentName, 'agent name'),
    runMode: exactText(record.runMode || 'isolated', 'agent run mode'),
  };
}

export function workspaceHash(canonicalWorkspace) {
  return crypto.createHash('sha256').update(String(canonicalWorkspace)).digest('hex').slice(0, 12);
}

function validateRuntimeInspection(candidate, inspected, expectedWorkspaceHash) {
  const labels = exactObject(inspected?.Config?.Labels, 'agent ownership labels');
  const name = String(inspected?.Name || '').replace(/^\//, '');
  const hostname = String(inspected?.Config?.Hostname || '').trim();
  if (inspected?.Id !== candidate.containerId
    || name !== candidate.containerName
    || inspected?.State?.Running !== true
    || inspected?.HostConfig?.Init !== true
    || labels[LABELS.managed] !== '1'
    || labels[LABELS.resource] !== 'agent'
    || labels[LABELS.schema] !== '2'
    || labels[LABELS.workspace] !== expectedWorkspaceHash
    || !/^[a-f0-9]{64}$/.test(String(labels[LABELS.contract] || ''))
    || labels[LABELS.instanceId] !== candidate.instanceId
    || labels[LABELS.enableGeneration] !== candidate.enableGeneration) {
    throw new Error(`Agent ${candidate.agentName} did not prove exact current managed ownership.`);
  }
  const user = String(inspected?.Config?.User || '').trim() || '0:0';
  if (!CONTAINER_USER.test(user)) throw new Error(`Agent ${candidate.agentName} has an invalid runtime user.`);
  if (!CONTAINER_HOSTNAME.test(hostname)) {
    throw new Error(`Agent ${candidate.agentName} has an invalid runtime hostname.`);
  }
  const execIds = Array.isArray(inspected.ExecIDs) ? inspected.ExecIDs.map(String).sort() : [];
  if (execIds.some((id) => !EXEC_ID.test(id))) throw new Error('Agent inspection returned an invalid exec ID.');
  return { user, hostname, execIds };
}

export function resolveWebttyBoxEndpoint({ baseURL, boxBaseURL = baseURL } = {}) {
    const browserValue = String(baseURL || '');
    const boxValue = String(boxBaseURL || '');
    const portSuffix = '(?::[1-9][0-9]{0,4})?/?$';
    if (!new RegExp('^http://(?:localhost|127\\.0\\.0\\.1)' + portSuffix).test(browserValue)) {
        throw new Error('WebTTY requires an exact credential-free loopback HTTP SMOKE_BASE_URL origin.');
    }
    if (!new RegExp('^http://127\\.0\\.0\\.1' + portSuffix).test(boxValue)) {
        throw new Error('WebTTY requires SMOKE_BOX_BASE_URL=http://127.0.0.1:<selectedRouterHostPort>.');
    }
    let browser;
    let endpoint;
    try {
        browser = new URL(browserValue);
        endpoint = parseLocalScreenBaseUrl(boxValue);
    } catch (error) {
        throw new Error('WebTTY browser and Box URLs must have valid loopback HTTP ports.', { cause: error });
    }
    if ((browser.port || '80') !== endpoint.port) {
        throw new Error('WebTTY browser and Box URLs must select the same loopback Router host port.');
    }
    return endpoint;
}

export function collectWebttyRuntimeEvidence({
  baseURL,
  boxBaseURL = baseURL,
  workspaceRoot,
  selectedDirectory,
  expectedContainerName = '',
  expectedImageId = '',
  expectedImageRef = '',
  expectedPloinkySource = '',
  requireFreshImage = true,
  command = run,
  collectLiveBox = collectLiveBoxEvidence,
} = {}) {
  const endpoint = resolveWebttyBoxEndpoint({ baseURL, boxBaseURL });
  const canonicalWorkspace = fs.realpathSync(workspaceRoot);
  const canonicalSelected = fs.realpathSync(selectedDirectory);
  if (!segmentContains(canonicalWorkspace, canonicalSelected)) {
    throw new Error('WebTTY runtime evidence selection is outside the workspace.');
  }
  const box = collectLiveBox({
    baseURL: endpoint.baseURL,
    expectedContainerName,
    expectedImageId,
    expectedImageRef,
    expectedPloinkySource,
    expectedWorkspaceSource: canonicalWorkspace,
    requireFreshImage,
    command,
  });
  const mountedWorkspace = exactObject(box.workspaceSourceMount, 'outer Box workspace source mount');
  const mountedWorkspaceDestination = normalizeDestination(mountedWorkspace.destination);
  if (mountedWorkspaceDestination !== '/workspace' || mountedWorkspace.readWrite !== true) {
    throw new Error('Outer Box workspace source evidence must be the exact writable /workspace bind.');
  }
  const expectedWorkspaceHash = workspaceHash(mountedWorkspaceDestination);
  const agents = [];
  for (const { containerName, record } of readRegistry(canonicalWorkspace)) {
    const candidate = exactRuntimeRecord(containerName, record);
    if (!candidate) continue;
    const inspected = inspectNestedContainer(box.box.containerId, candidate.containerId, command);
    if (!inspected) continue;
    const { user, hostname, execIds } = validateRuntimeInspection(
      candidate,
      inspected,
      expectedWorkspaceHash,
    );
    const mapping = independentlyTranslateMount(canonicalSelected, inspected.Mounts, canonicalWorkspace);
    agents.push(Object.freeze({
      ...candidate,
      user,
      hostname,
      execIds: Object.freeze(execIds),
      mapping,
      projectedTarget: mapping ? Object.freeze({
        kind: 'agent',
        label: candidate.agentName,
        detail: `${candidate.repoName}/${candidate.agentName}`,
        access: mapping.access,
        cwdDisplay: mapping.translatedCwd,
      }) : null,
    }));
  }
  return Object.freeze({
    outerContainerId: box.box.containerId,
    workspaceHash: expectedWorkspaceHash,
    selectedDirectory: canonicalSelected,
    agents: Object.freeze(agents),
    eligibleTargets: Object.freeze(agents.map((agent) => agent.projectedTarget).filter(Boolean)),
  });
}

export function requireAgentEvidence(evidence, agentName, { eligible } = {}) {
  const matches = evidence.agents.filter((agent) => agent.agentName === agentName);
  if (matches.length !== 1) throw new Error(`Expected exactly one live ${agentName} runtime; found ${matches.length}.`);
  const selected = matches[0];
  if (eligible === true && !selected.mapping) throw new Error(`${agentName} must be eligible for the selected folder.`);
  if (eligible === false && selected.mapping) throw new Error(`${agentName} must not be eligible for the selected folder.`);
  return selected;
}

export function collectExactAgentState(evidence, agent, { command = run } = {}) {
  const inspected = inspectNestedContainer(evidence.outerContainerId, agent.containerId, command);
  if (!inspected) return Object.freeze({ present: false, running: false, execIds: Object.freeze([]) });
  const { execIds } = validateRuntimeInspection(agent, inspected, evidence.workspaceHash);
  return Object.freeze({
    present: true,
    running: true,
    execIds: Object.freeze(execIds),
  });
}

export function collectAgentProcessRows(evidence, agent, { command = run } = {}) {
  const before = inspectNestedContainer(evidence.outerContainerId, agent.containerId, command);
  if (!before || before.State?.Running !== true) {
    throw new Error('Exact agent process target is not running.');
  }
  const initPid = Number(before.State?.Pid || 0);
  if (!Number.isSafeInteger(initPid) || initPid <= 1) {
    throw new Error('Exact agent process target has an invalid init PID.');
  }
  const startedAt = String(before.State?.StartedAt || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(startedAt)) {
    throw new Error('Exact agent process target has an invalid start generation.');
  }
  const output = command('podman', [
    'exec', evidence.outerContainerId,
    '/usr/local/bin/node', '--input-type=module', '--eval',
    AGENT_PROCESS_SNAPSHOT_SOURCE, String(initPid),
  ], { json: true });
  const snapshot = exactObject(output, 'exact agent process snapshot');
  if (Object.keys(snapshot).sort().join(',') !== 'containerInit,rows') {
    throw new Error('Exact agent process snapshot has invalid fields.');
  }
  const containerInit = exactObject(snapshot.containerInit, 'agent process container init');
  if (Object.keys(containerInit).sort().join(',') !== 'pid,pidNamespace,startToken'
      || containerInit.pid !== initPid
      || !/^pid:\[[1-9][0-9]*\]$/.test(containerInit.pidNamespace)
      || !/^[1-9][0-9]*$/.test(containerInit.startToken)) {
    throw new Error('Exact agent process snapshot has an invalid container init identity.');
  }
  if (!Array.isArray(snapshot.rows)
      || snapshot.rows.length < 1 || snapshot.rows.length > MAX_AGENT_PROCESS_ROWS) {
    throw new Error('Exact agent process snapshot has an invalid row count.');
  }
  const rows = snapshot.rows.map((raw) => {
    const row = exactObject(raw, 'agent process row');
    if (Object.keys(row).sort().join(',') !== 'args,pid,pidNamespace,ppid,startToken'
        || !Number.isSafeInteger(row.pid) || row.pid <= 0
        || !Number.isSafeInteger(row.ppid) || row.ppid < 0
        || row.pidNamespace !== containerInit.pidNamespace
        || !/^[1-9][0-9]*$/.test(row.startToken)
        || typeof row.args !== 'string' || !row.args || row.args.includes('\0')
        || Buffer.byteLength(row.args, 'utf8') > 64 * 1024) {
      throw new Error('Exact agent process snapshot contains an invalid row.');
    }
    return Object.freeze({
      pid: row.pid,
      ppid: row.ppid,
      startToken: row.startToken,
      pidNamespace: row.pidNamespace,
      args: row.args,
    });
  });
  const byPid = new Map();
  for (const row of rows) {
    if (byPid.has(row.pid)) throw new Error('Exact agent process snapshot contains a duplicate PID.');
    byPid.set(row.pid, row);
  }
  const initRow = byPid.get(initPid);
  if (!initRow || initRow.startToken !== containerInit.startToken) {
    throw new Error('Exact agent process snapshot omits the stable container init PID.');
  }
  const after = inspectNestedContainer(evidence.outerContainerId, agent.containerId, command);
  if (!after || after.State?.Running !== true
      || Number(after.State?.Pid || 0) !== initPid
      || String(after.State?.StartedAt || '') !== startedAt) {
    throw new Error('Exact agent process target changed during its process snapshot.');
  }
  return Object.freeze(rows.map((row) => `${row.pid} ${row.ppid} ${row.args}`));
}

export function captureNestedPodmanEventCursor(evidence, { command = run } = {}) {
  if (!CONTAINER_ID.test(String(evidence?.outerContainerId || ''))) {
    throw new Error('Exact live Box identity is required to capture the nested event cursor.');
  }
  const cursor = String(command('podman', [
    'exec', evidence.outerContainerId,
    '/usr/local/bin/node', '--eval', 'process.stdout.write(new Date().toISOString())',
  ]) || '').trim();
  if (!EVENT_CURSOR.test(cursor) || new Date(cursor).toISOString() !== cursor) {
    throw new Error('Nested Podman event cursor is invalid.');
  }
  return cursor;
}

export function collectNestedContainerEvents(evidence, agent, { since, until, command = run } = {}) {
  if (!CONTAINER_ID.test(String(evidence?.outerContainerId || ''))
      || !CONTAINER_ID.test(String(agent?.containerId || ''))) {
    throw new Error('Exact Box and agent identities are required for the nested event audit.');
  }
  if (!EVENT_CURSOR.test(String(since || '')) || !EVENT_CURSOR.test(String(until || ''))
      || new Date(since).toISOString() !== since || new Date(until).toISOString() !== until
      || Date.parse(until) < Date.parse(since)) {
    throw new Error('Nested event audit cursors are invalid.');
  }
  const output = String(command('podman', [
    'exec', evidence.outerContainerId,
    '/usr/bin/podman', 'events',
    '--stream=false', '--no-trunc=true',
    '--since', since, '--until', until,
    '--filter', `container=${agent.containerId}`,
    '--format', 'json',
  ]) || '');
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 128) throw new Error('Nested event audit exceeded its bounded event inventory.');
  return Object.freeze(lines.map((line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch (_) {
      throw new Error('Nested event audit returned malformed JSON.');
    }
    const id = String(event?.ID || '');
    const status = String(event?.Status || '');
    const type = String(event?.Type || '');
    if (id !== agent.containerId || type !== 'container'
        || !/^[a-z][a-z0-9_-]{0,63}$/.test(status)
        || !Number.isSafeInteger(event?.time) || event.time < 1
        || !Number.isInteger(event?.timeNano) || event.timeNano < 1) {
      throw new Error('Nested event audit returned an invalid or foreign event.');
    }
    const execId = event?.Attributes?.execID === undefined ? '' : String(event.Attributes.execID);
    if (execId && !EXEC_ID.test(execId)) {
      throw new Error('Nested event audit returned an invalid exec ID.');
    }
    return Object.freeze({ id, type, status, time: event.time, timeNano: event.timeNano, execId });
  }));
}

const ROUTING_SERVER_IDENTITY_PREAMBLE = String.raw`
import fs from 'node:fs';
const NODE = '/usr/local/bin/node';
const WATCHDOG = '/opt/ploinky/cli/server/Watchdog.js';
const ROUTER = '/opt/ploinky/cli/server/RoutingServer.js';
const PID_FILE = '/workspace/.ploinky/running/router.pid';
const RECORD_DIRECTORY = '/run/ploinky/webtty';
const helperUid = process.getuid();
function fail(message) { throw new Error(message); }
function bounded(pathname, limit, encoding = null) {
  const handle = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(limit + 1);
    const count = fs.readSync(handle, buffer, 0, buffer.length, 0);
    if (count > limit) fail('bounded read exceeded');
    const value = buffer.subarray(0, count);
    return encoding ? value.toString(encoding) : value;
  } finally { fs.closeSync(handle); }
}
function statIdentity(text, expectedPid) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 1 || close <= open || Number(text.slice(0, open).trim()) !== expectedPid) fail('invalid proc stat');
  const fields = text.slice(close + 1).trim().split(/\s+/);
  if (fields.length < 20 || !/^[A-Za-z]$/.test(fields[0]) || fields[0] === 'Z') fail('invalid proc state');
  const ppid = Number(fields[1]);
  const startTime = fields[19];
  if (!Number.isSafeInteger(ppid) || ppid < 0 || !/^[1-9][0-9]*$/.test(startTime)) fail('invalid proc identity');
  return { pid: expectedPid, ppid, startTime };
}
function readProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) fail('invalid pid');
  const root = '/proc/' + pid;
  const before = statIdentity(bounded(root + '/stat', 65536, 'utf8'), pid);
  const status = bounded(root + '/status', 65536, 'utf8');
  const argv = bounded(root + '/cmdline', 65536, 'utf8').split('\0').filter(Boolean);
  const executable = fs.readlinkSync(root + '/exe');
  const after = statIdentity(bounded(root + '/stat', 65536, 'utf8'), pid);
  const uidMatch = status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m);
  const uids = uidMatch ? uidMatch.slice(1).map(Number) : [];
  if (before.startTime !== after.startTime || before.ppid !== after.ppid
      || uids.length !== 4 || uids.some((uid) => uid !== helperUid)) fail('unstable or foreign proc identity');
  return { ...after, uid: helperUid, executable, argv };
}
function sameProcess(left, right) {
  return left.pid === right.pid && left.ppid === right.ppid
    && left.startTime === right.startTime && left.uid === right.uid
    && left.executable === right.executable
    && JSON.stringify(left.argv) === JSON.stringify(right.argv);
}
function exactArgv(identity, expected, expectedParent = null) {
  return identity.executable === NODE
    && identity.argv.length === expected.length
    && identity.argv.every((value, index) => value === expected[index])
    && (expectedParent === null || identity.ppid === expectedParent);
}
function readWatchdogPid() {
  const before = fs.lstatSync(PID_FILE);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== helperUid
      || (before.mode & 0o022) !== 0 || before.size < 1 || before.size > 32) fail('unsafe Watchdog pid file');
  const text = bounded(PID_FILE, 32, 'utf8').trim();
  const after = fs.lstatSync(PID_FILE);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || !/^[1-9][0-9]{0,8}$/.test(text)) fail('unstable Watchdog pid file');
  return Number(text);
}
function inspectGeneration() {
  const watchdogPid = readWatchdogPid();
  const watchdog = readProcess(watchdogPid);
  if (!exactArgv(watchdog, [NODE, WATCHDOG])) fail('Watchdog identity mismatch');
  const childrenText = bounded('/proc/' + watchdogPid + '/task/' + watchdogPid + '/children', 4096, 'utf8').trim();
  const childTokens = childrenText ? childrenText.split(/\s+/) : [];
  if (childTokens.length > 64 || childTokens.some((value) => !/^[1-9][0-9]{0,8}$/.test(value))) {
    fail('invalid Watchdog child inventory');
  }
  const routers = [];
  for (const token of childTokens) {
    try {
      const candidate = readProcess(Number(token));
      if (exactArgv(candidate, [NODE, ROUTER], watchdogPid)) routers.push(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') throw error;
    }
  }
  if (routers.length !== 1) fail('expected exactly one exact RoutingServer child');
  const watchdogAgain = readProcess(watchdogPid);
  const routerAgain = readProcess(routers[0].pid);
  if (!sameProcess(watchdog, watchdogAgain) || !sameProcess(routers[0], routerAgain)
      || !exactArgv(routerAgain, [NODE, ROUTER], watchdogPid)) fail('Router generation changed during inspection');
  return { watchdog: watchdogAgain, router: routerAgain };
}
function publicGeneration(generation) {
  return {
    watchdogPid: generation.watchdog.pid,
    watchdogStartTime: generation.watchdog.startTime,
    routerPid: generation.router.pid,
    routerStartTime: generation.router.startTime,
  };
}
function recoveryDirectoryEntries() {
  const directory = fs.lstatSync(RECORD_DIRECTORY);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== helperUid
      || (directory.mode & 0o777) !== 0o700) fail('unsafe recovery directory');
  const entries = fs.readdirSync(RECORD_DIRECTORY);
  if (entries.length > 16) fail('oversized recovery directory');
  return entries;
}
function requireExactAgentRecord(expected) {
  const entries = recoveryDirectoryEntries();
  if (entries.length !== 1 || !/^[a-zA-Z0-9_-]{20,80}\.json$/.test(entries[0])) fail('expected one exact recovery record');
  const pathname = RECORD_DIRECTORY + '/' + entries[0];
  const before = fs.lstatSync(pathname);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== helperUid
      || (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 16384) fail('unsafe recovery record');
  const raw = bounded(pathname, 16384, 'utf8');
  const after = fs.lstatSync(pathname);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) fail('unstable recovery record');
  const record = JSON.parse(raw);
  const targetKeys = Object.keys(record?.target || {}).sort();
  if (record?.schema !== 'ploinky-webtty-recovery/v2' || record?.targetKind !== 'agent'
      || record?.ptyState !== 'pty-ready' || !record?.agent
      || JSON.stringify(targetKeys) !== JSON.stringify(['containerId','containerName','enableGeneration','instanceId','runtime'])
      || record.target.runtime !== 'podman'
      || record.target.containerId !== expected.containerId
      || record.target.containerName !== expected.containerName
      || record.target.instanceId !== expected.instanceId
      || record.target.enableGeneration !== expected.enableGeneration) fail('recovery record target mismatch');
  return { recordCount: 1, targetKind: 'agent', ptyState: 'pty-ready', matchesExpectedTarget: true };
}
`;
const READ_ROUTING_SERVER_SCRIPT = `${ROUTING_SERVER_IDENTITY_PREAMBLE}
process.stdout.write(JSON.stringify(publicGeneration(inspectGeneration())));
`;
const CRASH_ROUTING_SERVER_SCRIPT = `${ROUTING_SERVER_IDENTITY_PREAMBLE}
const expected = JSON.parse(Buffer.from(process.argv[1] || '', 'base64url').toString('utf8'));
const expectedKeys = Object.keys(expected || {}).sort();
if (JSON.stringify(expectedKeys) !== JSON.stringify(['containerId','containerName','enableGeneration','instanceId','runtime'])
    || expected.runtime !== 'podman') fail('invalid expected target');
const generation = inspectGeneration();
const recoveryRecord = requireExactAgentRecord(expected);
const revalidated = inspectGeneration();
if (!sameProcess(generation.watchdog, revalidated.watchdog)
    || !sameProcess(generation.router, revalidated.router)) fail('generation changed before crash');
process.kill(revalidated.router.pid, 'SIGKILL');
process.stdout.write(JSON.stringify({ ...publicGeneration(revalidated), recoveryRecord }));
`;
const READ_RECOVERY_DIRECTORY_SCRIPT = `${ROUTING_SERVER_IDENTITY_PREAMBLE}
const entries = recoveryDirectoryEntries();
process.stdout.write(JSON.stringify({
  recordCount: entries.filter((entry) => entry.endsWith('.json') && !entry.startsWith('.')).length,
  temporaryCount: entries.filter((entry) => entry.startsWith('.')).length,
  otherCount: entries.filter((entry) => !entry.endsWith('.json')).length,
}));
`;

function exactRouterProcessEvidence(evidence, script, command, extraArgs = []) {
  if (!CONTAINER_ID.test(String(evidence?.outerContainerId || ''))) {
    throw new Error('Exact live Box identity is required to inspect RoutingServer.');
  }
  const result = command('podman', [
    'exec', '--user', 'podman', evidence.outerContainerId,
    '/usr/local/bin/node', '--input-type=module', '--eval', script,
    ...extraArgs,
  ], { json: true });
  const keys = Object.keys(result || {}).sort();
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !Number.isSafeInteger(result.watchdogPid) || result.watchdogPid < 2
    || !/^[1-9][0-9]*$/.test(String(result.watchdogStartTime || ''))
    || !Number.isSafeInteger(result.routerPid) || result.routerPid < 2
    || !/^[1-9][0-9]*$/.test(String(result.routerStartTime || ''))
    || !['routerPid', 'routerStartTime', 'watchdogPid', 'watchdogStartTime'].every((key) => keys.includes(key))) {
    throw new Error('RoutingServer crash did not return exact process identity evidence.');
  }
  return result;
}

export function collectExactRoutingServerIdentity(evidence, { command = run } = {}) {
  const result = exactRouterProcessEvidence(evidence, READ_ROUTING_SERVER_SCRIPT, command);
  if (Object.keys(result).length !== 4) throw new Error('RoutingServer identity returned unexpected evidence.');
  return Object.freeze({
    watchdogPid: result.watchdogPid,
    watchdogStartTime: String(result.watchdogStartTime),
    routerPid: result.routerPid,
    routerStartTime: String(result.routerStartTime),
  });
}

export function crashExactRoutingServer(evidence, agent, { command = run } = {}) {
  const target = {
    runtime: agent?.runtime,
    containerId: agent?.containerId,
    containerName: agent?.containerName,
    instanceId: agent?.instanceId,
    enableGeneration: agent?.enableGeneration,
  };
  if (target.runtime !== 'podman' || !CONTAINER_ID.test(String(target.containerId || ''))
    || [target.containerName, target.instanceId, target.enableGeneration].some((value) => (
      typeof value !== 'string' || !value || value !== value.trim()
    ))) {
    throw new Error('Exact agent identity is required for Router crash recovery evidence.');
  }
  const encodedTarget = Buffer.from(JSON.stringify(target)).toString('base64url');
  const result = exactRouterProcessEvidence(
    evidence,
    CRASH_ROUTING_SERVER_SCRIPT,
    command,
    [encodedTarget],
  );
  if (Object.keys(result).sort().join(',') !== 'recoveryRecord,routerPid,routerStartTime,watchdogPid,watchdogStartTime'
    || JSON.stringify(result.recoveryRecord) !== JSON.stringify({
      recordCount: 1,
      targetKind: 'agent',
      ptyState: 'pty-ready',
      matchesExpectedTarget: true,
    })) {
    throw new Error('RoutingServer crash did not prove the exact durable agent recovery record.');
  }
  return Object.freeze({
    watchdogPid: result.watchdogPid,
    watchdogStartTime: String(result.watchdogStartTime),
    routerPid: result.routerPid,
    routerStartTime: String(result.routerStartTime),
    recoveryRecord: Object.freeze({ ...result.recoveryRecord }),
  });
}

export function collectWebttyRecoveryDirectoryState(evidence, { command = run } = {}) {
  if (!CONTAINER_ID.test(String(evidence?.outerContainerId || ''))) {
    throw new Error('Exact live Box identity is required to inspect WebTTY recovery state.');
  }
  const result = command('podman', [
    'exec', '--user', 'podman', evidence.outerContainerId,
    '/usr/local/bin/node', '--input-type=module', '--eval', READ_RECOVERY_DIRECTORY_SCRIPT,
  ], { json: true });
  if (JSON.stringify(result) !== JSON.stringify({ recordCount: 0, temporaryCount: 0, otherCount: 0 })) {
    throw new Error('WebTTY recovery directory retained runtime records or residue.');
  }
  return Object.freeze({ ...result });
}
