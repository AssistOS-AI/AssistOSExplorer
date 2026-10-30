import fs from 'node:fs/promises';
import path from 'node:path';

const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

// Canonical skill sources already visible through the read-only workspace do
// not need another bind. Sources inside the writable cwd still need protection.
export function alaSkillMountArguments({ snapshot, workspaceRoot, cwd, includeClaude = true }) {
    if (!snapshot.skillsDirectory) return [];
    const args = [];
    const privateRoot = path.join(cwd, '.roboteam');
    for (const mount of snapshot.mounts || []) {
        const covered = workspaceRoot !== cwd && mount.source === mount.target
            && inside(workspaceRoot, mount.target) && !inside(cwd, mount.target)
            && !inside(privateRoot, mount.target);
        if (!covered) args.push('--folder', mount.source, 'at', mount.target, 'expose');
    }
    args.push('--folder', snapshot.skillsDirectory, 'at', path.join(cwd, '.agents', 'skills'), 'expose');
    if (includeClaude) {
        args.push('--folder', snapshot.skillsDirectory, 'at', path.join(cwd, '.claude', 'skills'), 'expose');
    }
    return args;
}

// The `--folder` arguments that expose the session skill overlay inside the project. Existing
// `.claude` -> `.agents` aliases already see the same overlay. Shared by every execution engine.
export async function alaSkillFolderArguments({ snapshot, workspaceRoot, cwd }) {
    if (!snapshot.skillsDirectory) return [];
    const claude = path.join(cwd, '.claude');
    const claudeStat = await fs.lstat(claude).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (claudeStat?.isSymbolicLink()
        && await fs.realpath(claude) !== await fs.realpath(path.join(cwd, '.agents'))) {
        throw new Error('Project .claude symlink must point to .agents for session skills.');
    }
    return alaSkillMountArguments({ snapshot, workspaceRoot, cwd, includeClaude: !claudeStat?.isSymbolicLink() });
}

// Appended to the native prompt of a workflow execution that has the failure skill.
export const FAILURE_SKILL_PROMPT = '\n\nRead /workspace/report-task-blocked/SKILL.md. Use this required skill if missing resources, access or capabilities prevent fulfilling the agreed task and plan.';

// Parses ALA `--folder` arguments (`<path> [write] [as <alias> | at <abs>] [expose]`, each preceded
// by `--folder`) and `--ignore <path>` arguments into the structured form the worker takes.
export function alaFolderSpecifications(args) {
    const folders = [];
    const ignore = [];
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--ignore') { ignore.push(args[index + 1]); index += 1; continue; }
        if (args[index] !== '--folder') continue;
        const folder = { path: args[index + 1], access: 'read' };
        index += 1;
        while (index + 1 < args.length && args[index + 1] !== '--folder' && args[index + 1] !== '--ignore') {
            const token = args[index + 1];
            if (token === 'write') { folder.access = 'write'; index += 1; }
            else if (token === 'as') { folder.as = args[index + 2]; index += 2; }
            else if (token === 'at') { folder.at = args[index + 2]; index += 2; }
            else if (token === 'expose') { folder.expose = true; index += 1; }
            else break;
        }
        folders.push(folder);
    }
    return { folders, ignore };
}
