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
