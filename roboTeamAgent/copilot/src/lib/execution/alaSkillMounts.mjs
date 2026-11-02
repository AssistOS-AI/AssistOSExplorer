import fs from 'node:fs/promises';
import path from 'node:path';

const inside = (root, value) => value === root || value.startsWith(root + path.sep);

// The real place a path below the working folder names, keeping the part that does not exist yet.
async function realPlace(target) {
    const missing = [];
    for (let existing = target; ; existing = path.dirname(existing)) {
        try { return path.join(await fs.realpath(existing), ...missing); }
        catch (error) {
            // A dangling link, like a loop or a file on the way, cannot hold an overlay.
            if (error.code !== 'ENOENT' || await fs.lstat(existing).catch(() => null)) return null;
            missing.unshift(path.basename(existing));
        }
    }
}

// Decides before mounting where the session skills overlay goes. Sandboxes bind by descriptor, which refuses a link as
// the destination, and a robot writing a shared folder must not be able to stop other robots' turns: a link that stays in
// the working folder is followed, two names for one place get one mount, and anything else is skipped with a diagnostic.
export async function skillOverlayTargets(cwd) {
    const places = new Map(), skipped = [];
    for (const name of ['.agents', '.claude']) {
        const place = await realPlace(path.join(cwd, name, 'skills'));
        const directory = place && (await fs.stat(place).catch(() => null))?.isDirectory() !== false;
        if (directory && inside(cwd, place) && place !== cwd && !inside(path.join(cwd, '.roboteam'), place)) places.set(name, place);
        else skipped.push(path.join(name, 'skills'));
    }
    // A mount cannot sit inside another read-only mount. The narrower one stays, because it hides less of the project.
    for (const [name, place] of places) {
        if ([...places.values()].some(other => other !== place && inside(place, other))) { places.delete(name); skipped.push(path.join(name, 'skills')); }
    }
    return { targets: [...new Set(places.values())], skipped };
}

// Every skill source is mounted, because a robot sees only its home, its cwd and
// the folders granted for the run, never the workspace around them.
export function alaSkillMountArguments({ snapshot, cwd, targets = [path.join(cwd, '.agents', 'skills'), path.join(cwd, '.claude', 'skills')] }) {
    if (!snapshot.skillsDirectory) return [];
    const args = [];
    for (const mount of snapshot.mounts || []) args.push('--folder', mount.source, 'at', mount.target, 'expose');
    for (const target of targets) args.push('--folder', snapshot.skillsDirectory, 'at', target, 'expose');
    return args;
}
