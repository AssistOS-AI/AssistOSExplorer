import fs from 'node:fs';
import path from 'node:path';
import { remoteUrlOrEmpty } from './repository-url-projection.mjs';

// Outward robot views. Repository sources may be physical paths or
// credential-bearing URLs, and an active task's cwd is a physical path. Only a
// caller proven to be a verified non-guest administrator receives them raw;
// every other caller, including internal and unverified ones, gets the
// restricted view. Stored robot and task configuration is never changed here.

function workspaceRoots(workspaceRoot) {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot) return [];
    const roots = new Set([path.resolve(workspaceRoot)]);
    try { roots.add(fs.realpathSync(workspaceRoot)); } catch { /* the resolved path alone is used */ }
    return [...roots];
}

// A workspace-relative reference for a contained absolute path, '.' for the
// workspace itself, or null when the path is missing, relative or escapes.
export function containedWorkspaceReference(value, workspaceRoot) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
    const target = path.resolve(value);
    for (const root of workspaceRoots(workspaceRoot)) {
        const relative = path.relative(root, target);
        if (relative === '') return '.';
        if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return relative;
    }
    return null;
}

function restrictedRun(run, workspaceRoot) {
    if (!run || typeof run !== 'object' || !run.task || typeof run.task !== 'object') return run;
    const { cwd, ...task } = run.task;
    const reference = containedWorkspaceReference(cwd, workspaceRoot);
    return { ...run, task: { ...task, ...(reference === null ? {} : { cwd: reference }) } };
}

export function projectRobotView(view, { privileged = false, workspaceRoot = '' } = {}) {
    if (privileged === true) return view;
    return {
        ...view,
        repositories: (view.repositories || []).map((repository) => ({ ...repository, source: remoteUrlOrEmpty(repository.source) })),
        run: restrictedRun(view.run, workspaceRoot),
    };
}
