import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { assertBoxWorkspacePath, validateSamePathWorkspaceMount } from './box-workspace.mjs';

const HEX_ID = /^[0-9a-f]{64}$/;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const inside = (root, candidate) => candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
export const overlaps = (left, right) => inside(left, right) || inside(right, left);

// Use the runtime's semantic verifier, and emit only source/runtime identities.
// Captured agent configuration and authentication policy must not enter evidence.
// The Box mounts the workspace at its own host path, so the admitted root is passed as one JSON string literal.
export function activeRuntimeProbe(workspaceRoot) {
  return `
import { loadActiveEdgeRoutingGeneration } from '/opt/ploinky/cli/sandbox/edgeGeneration.js';
const workspaceRoot = ${JSON.stringify(workspaceRoot)};
const { selector, generation } = loadActiveEdgeRoutingGeneration({ workspaceRoot });
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const bindings = {};
for (const key of ['explorer', 'achilles-cli']) {
  const route = generation.routing.routes[key];
  bindings[key] = route ? {
    route: { ...pick(route, ['repo', 'agent', 'container', 'hostPath', 'alias', 'disabled', 'draining', 'hostPort']),
      hasServiceTargets: Boolean(route.serviceTargets && Object.keys(route.serviceTargets).length) },
    record: pick(generation.agents[route.container], ['type', 'repoName', 'agentName', 'alias', 'instanceId', 'enableGeneration', 'runtime', 'containerId'])
  } : null;
}
process.stdout.write(JSON.stringify({ generation: selector.generation, activationId: selector.activationId, bindings }));
`;
}

function command(args) {
  const result = spawnSync('podman', args, { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Unable to inspect local snapshot runtime source bindings.');
  return result.stdout;
}

// `subject` names the evidence mode in the thrown messages; the checks themselves are mode independent.
// `lexical` additionally requires the reported Source to be spelled exactly as expected, so a symlink alias of the
// expected canonical directory is not accepted. An unreadable Source is a mismatch, never a different error.
export function requireMount(mounts, destination, source, { readOnly = false, fsApi, lexical = false, subject = 'Local snapshot' } = {}) {
  const selected = mounts.filter(mount => mount.Destination === destination);
  const canonical = value => { try { return fsApi.realpathSync(value); } catch { return null; } };
  if (selected.length !== 1 || selected[0].Type !== 'bind'
      || (readOnly && selected[0].RW !== false)
      || (lexical && selected[0].Source !== source)
      || (fsApi ? canonical(selected[0].Source) !== source : selected[0].Source !== source)) {
    throw new Error(`${subject} requires the exact verified ${readOnly ? 'read-only ' : ''}source mount at ${destination}.`);
  }
  return selected[0];
}

export function rejectShadows(mounts, protectedPaths, allowed, { subject = 'Local snapshot' } = {}) {
  for (const mount of mounts) {
    if (allowed.includes(mount)) continue;
    const destination = mount.Destination;
    if (typeof destination !== 'string' || !destination.startsWith('/') || path.posix.normalize(destination) !== destination
        || protectedPaths.some(protectedPath => overlaps(destination, protectedPath))) {
      throw new Error(`${subject} has a mount shadowing a verified source or runtime.`);
    }
  }
}

// The workspace is mounted at its own host path, so a runtime path inside it is also its host path.
// Lexical containment is checked here; callers prove canonical containment with a real directory/realpath check.
function workspacePath(workspace, runtimePath) {
  if (typeof runtimePath !== 'string' || !runtimePath.startsWith(`${workspace}/`) || path.posix.normalize(runtimePath) !== runtimePath) {
    throw new Error('Local snapshot runtime path is outside the verified workspace.');
  }
  return runtimePath;
}

function inspectedWorkspaceSource(workspace, source) {
  if (typeof source !== 'string' || !source.startsWith(`${workspace}/`) || path.posix.normalize(source) !== source) {
    throw new Error('Local snapshot source is outside the inspected workspace.');
  }
  return source;
}

function sameStat(before, after) {
  return ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key]);
}

// Staging copies all Agent entries except its root dependency adapter. This
// digest includes directories, symlink targets, file bytes and executable bits.
function agentTreeDigest(root, fsApi) {
  const entries = [];
  const visit = (relative = '') => {
    const file = path.join(root, relative);
    const before = fsApi.lstatSync(file);
    if (before.isDirectory()) {
      entries.push([relative, 'directory', before.mode & 0o111]);
      const names = fsApi.readdirSync(file).sort().filter(name => relative || name !== 'node_modules');
      for (const name of names) visit(relative ? `${relative}/${name}` : name);
    } else if (before.isFile()) {
      if (before.size > 128 * 1024 * 1024) throw new Error('Local snapshot Agent entry is too large to verify.');
      entries.push([relative, 'file', before.mode & 0o111, sha256(fsApi.readFileSync(file))]);
    } else if (before.isSymbolicLink()) {
      entries.push([relative, 'symlink', fsApi.readlinkSync(file)]);
    } else {
      throw new Error('Local snapshot Agent tree contains an unsupported entry.');
    }
    if (entries.length > 100000 || !sameStat(before, fsApi.lstatSync(file))) {
      throw new Error('Local snapshot Agent tree changed while being verified.');
    }
  };
  if (!fsApi.lstatSync(root).isDirectory() || fsApi.realpathSync(root) !== root) {
    throw new Error('Local snapshot Agent staging must be a real directory.');
  }
  visit();
  return sha256(JSON.stringify(entries));
}

// The Box's bounded core exec always supplies the selected physical host ports
// (ploinky-box/command/execute.mjs, supervisor boundedCoreEnvironment) because
// loadActiveEdgeRoutingGeneration fails closed for any other port selection.
// The probe must carry the exact ports already verified in the live Box evidence.
const EXACT_PORT = /^[1-9][0-9]{0,4}$/;
function selectedHostPorts(liveBox) {
  const router = String(liveBox?.box?.selectedRouterHostPort ?? '');
  const media = String(liveBox?.box?.semanticLabels?.mediaHostPort ?? '');
  for (const value of [router, media]) {
    if (!EXACT_PORT.test(value) || Number(value) > 65535) {
      throw new Error('Local snapshot requires the exact selected Router and media host ports from the live Box.');
    }
  }
  return Object.freeze({ router, media });
}

function readActiveGeneration(run, outerId, ports, workspace) {
  const result = JSON.parse(run([
    'exec',
    '--env', `PLOINKY_ROUTER_HOST_PORT=${ports.router}`,
    '--env', `PLOINKY_MEDIA_HOST_PORT=${ports.media}`,
    outerId, 'node', '--input-type=module', '-e', activeRuntimeProbe(workspace),
  ]));
  if (!/^sha256:[0-9a-f]{64}$/.test(result.generation || '')
      || typeof result.activationId !== 'string' || !result.activationId.trim() || !result.bindings) {
    throw new Error('Local snapshot requires a verified active routing generation.');
  }
  return result;
}

export function collectLocalSnapshotSourceBindings({ liveBox, repositories, requireActiveAchillesCLI = true, run = command, fsApi = fs } = {}) {
  if (typeof requireActiveAchillesCLI !== 'boolean') throw new Error('requireActiveAchillesCLI must be a boolean.');
  const mountedWorkspace = liveBox?.workspaceSourceMount?.source;
  const workspace = mountedWorkspace ? fsApi.realpathSync(mountedWorkspace) : '';
  const outerId = liveBox?.box?.containerId;
  if (!workspace || !HEX_ID.test(outerId || '')) throw new Error('Local snapshot requires the exact live workspace mount and Box ID.');
  assertBoxWorkspacePath(workspace);
  const ports = selectedHostPorts(liveBox);
  const outerMounts = JSON.parse(run(['container', 'inspect', outerId, '--format', '{{json .Mounts}}']));
  // The exact outer root proof: one writable same-path bind, and no second alias of its source.
  validateSamePathWorkspaceMount(outerMounts, workspace);
  const libSource = fsApi.realpathSync(repositories.achillesAgentLib.repositoryPath);
  const ploinkySource = fsApi.realpathSync(repositories.ploinky.repositoryPath);
  const allowedOuter = [
    requireMount(outerMounts, workspace, workspace, { fsApi }),
    requireMount(outerMounts, '/opt/ploinky', ploinkySource, { readOnly: true, fsApi }),
    requireMount(outerMounts, '/opt/ploinky-agentlib', libSource, { readOnly: true, fsApi }),
  ];
  const libAlias = inspectedWorkspaceSource(workspace, libSource);
  if (outerMounts.some(mount => mount.Destination === libAlias)) {
    allowedOuter.push(requireMount(outerMounts, libAlias, libSource, { readOnly: true, fsApi }));
  }
  if (outerMounts.some(mount => mount.Destination === '/opt/ploinky/node_modules')) {
    allowedOuter.push(requireMount(outerMounts, '/opt/ploinky/node_modules',
      fsApi.realpathSync(path.join(workspace, '.ploinky/box/dependencies')), { fsApi }));
  }
  const sources = Object.fromEntries([['explorer', 'explorer'], ['achillesCLI', 'achilles-cli']].map(([name, routeKey]) => {
    const source = fsApi.realpathSync(path.join(repositories[name].repositoryPath, routeKey));
    return [name, { source, runtimeSource: inspectedWorkspaceSource(workspace, source), treeSha256: repositories[name].treeSha256, routeKey }];
  }));
  const protectedOuter = ['/opt/ploinky', '/opt/ploinky-agentlib', libAlias, ...Object.values(sources).map(value => value.runtimeSource)];
  rejectShadows(outerMounts, protectedOuter, allowedOuter);
  const agentSource = path.join(ploinkySource, 'Agent');
  const agentDigest = agentTreeDigest(agentSource, fsApi);
  const active = readActiveGeneration(run, outerId, ports, workspace);
  const ids = run(['exec', outerId, 'podman', 'ps', '--quiet', '--no-trunc']).trim().split(/\s+/).filter(Boolean);
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !HEX_ID.test(id))) throw new Error('Invalid nested runtime inventory.');
  const format = '{"id":{{json .ID}},"running":{{json .State.Running}},"mounts":{{json .Mounts}}}';
  const containers = run(['exec', outerId, 'podman', 'container', 'inspect', ...ids, '--format', format])
    .trim().split('\n').map(line => JSON.parse(line));
  const result = {
    achillesAgentLib: Object.freeze({ source: libSource, runtimeSource: '/opt/ploinky-agentlib', treeSha256: repositories.achillesAgentLib.treeSha256 }),
    ploinkyAgent: Object.freeze({ source: agentSource, runtimeSource: '/Agent', treeSha256: agentDigest }),
  };
  for (const [name, { routeKey, ...identity }] of Object.entries(sources)) {
    const selected = active.bindings[routeKey];
    const route = selected?.route;
    if (!route || route.disabled === true) {
      if (name !== 'achillesCLI' || requireActiveAchillesCLI) throw new Error(`${name} requires an active source-bound route.`);
      result[name] = Object.freeze({ active: false, ...identity });
      continue;
    }
    const record = selected.record;
    if (route.draining === true || route.hostPath !== identity.runtimeSource || !route.container || !route.repo || route.agent !== routeKey
        || record?.type !== 'agent' || record.repoName !== route.repo || record.agentName !== route.agent
        || routeKey !== (record.alias || record.agentName) || (route.alias || '') !== (record.alias || '')
        || (record.runtime !== undefined && !['docker', 'podman'].includes(record.runtime))
        || typeof record.instanceId !== 'string' || !record.instanceId.trim()
        || typeof record.enableGeneration !== 'string' || !record.enableGeneration.trim()) {
      throw new Error(`${name} does not have an exact active route and captured runtime identity.`);
    }
    // A semantic preparation can declare CLI before any exact container is
    // admitted. Preflight records that source without claiming it is ready.
    const targetlessPreparation = (record.containerId === undefined || record.containerId === null || record.containerId === '')
      && (route.hostPort === undefined || route.hostPort === null) && route.hasServiceTargets === false;
    if (name === 'achillesCLI' && !requireActiveAchillesCLI && targetlessPreparation) {
      result[name] = Object.freeze({ active: false, ...identity });
      continue;
    }
    if (!['docker', 'podman'].includes(record.runtime) || !HEX_ID.test(record.containerId || '')) {
      throw new Error(`${name} does not have an exact active route and captured runtime identity.`);
    }
    const matches = containers.filter(container => container.id === record.containerId && container.running === true);
    if (matches.length !== 1 || !ids.includes(record.containerId)) throw new Error(`${name} active container is not running in the inspected inventory.`);
    const container = matches[0];
    const allowedInner = [
      requireMount(container.mounts, identity.runtimeSource, identity.runtimeSource),
      requireMount(container.mounts, '/opt/ploinky-agentlib', '/opt/ploinky-agentlib', { readOnly: true }),
    ];
    const roots = {};
    for (const [mountPath, field, readOnly] of [['/code', 'codeRoot', false], ['/Agent', 'agentRuntimeRoot', true]]) {
      const mounts = container.mounts.filter(mount => mount.Destination === mountPath);
      if (mounts.length !== 1 || !mounts[0].Source?.startsWith(`${workspace}/.ploinky/container-runtime/`)) {
        throw new Error(`${name} has an unverified runtime mount at ${mountPath}.`);
      }
      const mount = requireMount(container.mounts, mountPath, mounts[0].Source, { readOnly });
      const host = workspacePath(workspace, mount.Source);
      if (!fsApi.lstatSync(host).isDirectory() || fsApi.realpathSync(host) !== host) throw new Error(`${name} runtime staging is not a real workspace directory.`);
      roots[field] = host;
      protectedOuter.push(mount.Source);
      allowedInner.push(mount);
    }
    // Explorer mounts its repository parent for browsing. A self-mounted
    // workspace ancestor preserves the exact path only if the outer namespace
    // also proves that whole parent is backed by the verified workspace.
    for (const mount of container.mounts) {
      if (allowedInner.includes(mount) || mount.Type !== 'bind' || mount.Source !== mount.Destination
          || !inside(workspace, mount.Destination) || !inside(mount.Destination, identity.runtimeSource)) continue;
      const host = mount.Destination === workspace ? workspace : workspacePath(workspace, mount.Destination);
      if (!fsApi.lstatSync(host).isDirectory() || fsApi.realpathSync(host) !== host) {
        throw new Error(`${name} source ancestor mount is not the exact workspace directory.`);
      }
      allowedInner.push(mount);
      protectedOuter.push(mount.Destination);
    }
    const protectedInner = ['/code', '/Agent', '/opt/ploinky-agentlib', identity.runtimeSource];
    // Podman stages both dependency adapters as links to one read-only self
    // mount. The excluded dependency tree must not hide a second code mount.
    const dependencyTargets = Object.values(roots).map(root => {
      const adapter = path.join(root, 'node_modules');
      if (!fsApi.lstatSync(adapter).isSymbolicLink()) throw new Error(`${name} dependency adapter is not a staged symbolic link.`);
      return fsApi.readlinkSync(adapter);
    });
    if (dependencyTargets[0] !== dependencyTargets[1]
        || !dependencyTargets[0].startsWith(`${workspace}/.ploinky/`)) {
      throw new Error(`${name} dependency adapters do not share the prepared workspace dependency tree.`);
    }
    const dependencyTarget = dependencyTargets[0];
    workspacePath(workspace, dependencyTarget);
    allowedInner.push(requireMount(container.mounts, dependencyTarget, dependencyTarget, { readOnly: true }));
    protectedInner.push(dependencyTarget);
    protectedOuter.push(dependencyTarget);
    rejectShadows(container.mounts, protectedInner, allowedInner);
    rejectShadows(outerMounts, protectedOuter, allowedOuter);
    const mappings = [];
    for (const entry of fsApi.readdirSync(identity.source).filter(entry => entry !== 'node_modules').sort()) {
      const codeFile = path.join(roots.codeRoot, entry);
      if (!fsApi.lstatSync(codeFile).isSymbolicLink() || fsApi.readlinkSync(codeFile) !== `${identity.runtimeSource}/${entry}`) {
        throw new Error(`${name} runtime code is not linked to the verified source: ${entry}`);
      }
      mappings.push([entry, `${identity.runtimeSource}/${entry}`]);
    }
    if (fsApi.readdirSync(roots.codeRoot).some(entry => entry !== 'node_modules' && !mappings.some(([name]) => name === entry))) {
      throw new Error(`${name} runtime code has unexpected source entries.`);
    }
    if (agentTreeDigest(roots.agentRuntimeRoot, fsApi) !== agentDigest) throw new Error(`${name} staged /Agent differs from the verified Ploinky Agent source.`);
    result[name] = Object.freeze({ active: true, ...identity, containerId: container.id, ...roots,
      routeKey, instanceId: record.instanceId, enableGeneration: record.enableGeneration,
      mappingSha256: sha256(JSON.stringify(mappings)) });
  }
  const current = readActiveGeneration(run, outerId, ports, workspace);
  if (current.generation !== active.generation || current.activationId !== active.activationId) {
    throw new Error('Local snapshot active routing generation changed during inspection.');
  }
  if (agentTreeDigest(agentSource, fsApi) !== agentDigest) throw new Error('Local snapshot Ploinky Agent source changed during inspection.');
  return Object.freeze(result);
}
