import path from 'node:path';

export function assertBoxWorkspacePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value === '/'
    || !value.isWellFormed() || /[\u0000-\u001f\u007f\\:]/u.test(value)
    || /\s$/u.test(value) || value.endsWith('/') || path.posix.normalize(value) !== value) {
    throw new Error('Box workspace root must be one clean absolute host path.');
  }
  return value;
}

export function validateSamePathWorkspaceMount(mounts, workspaceRoot) {
  const root = assertBoxWorkspacePath(workspaceRoot);
  if (!Array.isArray(mounts)) throw new Error('Live Box inspection must include its exact mount inventory.');
  const candidates = mounts.filter((mount) => (mount?.Destination ?? mount?.destination) === root);
  if (candidates.length !== 1) throw new Error(`Live Box must have exactly one ${root} source mount.`);
  const mount = candidates[0];
  if (String(mount.Type ?? mount.type).toLowerCase() !== 'bind'
    || (mount.RW ?? mount.rw) !== true) {
    throw new Error('Live Box workspace must be one absolute writable bind mount.');
  }
  if ((mount.Source ?? mount.source) !== root) {
    throw new Error('Live Box workspace source does not equal its destination and expected host workspace.');
  }
  if (mounts.some((entry) => entry !== mount
    && (entry?.Source ?? entry?.source) === root)) {
    throw new Error('Live Box must not expose another alias of its workspace source.');
  }
  return Object.freeze({ type: 'bind', source: root, destination: root, readWrite: true });
}

// Runtime environment and cwd come from the exact inspected container, never
// from a browser request or a fixed image default.
export function inspectBoxWorkspace(container) {
  const environment = container?.Config?.Env;
  if (!Array.isArray(environment)) throw new Error('Live Box workspace environment is missing.');
  const entries = environment.filter((entry) => typeof entry === 'string'
    && entry.startsWith('PLOINKY_WORKSPACE_ROOT='));
  if (entries.length !== 1) throw new Error('Live Box must declare exactly one PLOINKY_WORKSPACE_ROOT.');
  const root = assertBoxWorkspacePath(entries[0].slice('PLOINKY_WORKSPACE_ROOT='.length));
  if (container.Config.WorkingDir !== root) throw new Error('Live Box cwd does not equal its workspace root.');
  return validateSamePathWorkspaceMount(container.Mounts, root);
}
