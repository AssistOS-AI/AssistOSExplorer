import path from 'node:path';

// Every skill source is mounted, because a robot sees only its home, its cwd and
// the folders granted for the run, never the workspace around them.
export function alaSkillMountArguments({ snapshot, cwd, includeClaude = true }) {
    if (!snapshot.skillsDirectory) return [];
    const args = [];
    for (const mount of snapshot.mounts || []) args.push('--folder', mount.source, 'at', mount.target, 'expose');
    args.push('--folder', snapshot.skillsDirectory, 'at', path.join(cwd, '.agents', 'skills'), 'expose');
    if (includeClaude) {
        args.push('--folder', snapshot.skillsDirectory, 'at', path.join(cwd, '.claude', 'skills'), 'expose');
    }
    return args;
}
