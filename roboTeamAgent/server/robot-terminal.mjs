import { requireWorkspaceRoot } from './workspace-root.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const ROBOT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;

export async function robotTerminalDirectory(store, robotId, workspaceRoot = requireWorkspaceRoot()) {
    const home = store.robotPath(robotId);
    const directory = `.data/roboTeamAgent/robots/${robotId}`;
    const workspaceHome = path.join(workspaceRoot, directory);
    const [actual, projected] = await Promise.all([fs.lstat(home), fs.lstat(workspaceHome)]);
    if (!actual.isDirectory() || actual.isSymbolicLink() || !projected.isDirectory() || projected.isSymbolicLink()
        || actual.dev !== projected.dev || actual.ino !== projected.ino) {
        throw new Error('Robot home is not available through the workspace mount.');
    }
    const root = await fs.realpath(workspaceRoot);
    const resolved = await fs.realpath(workspaceHome);
    if (!resolved.startsWith(root + path.sep)) throw new Error('Robot home is outside the workspace.');
    return directory;
}

// Terminal profiles are an administrator surface decided on the signed
// request only: a verified direct user (no internal token, no compatibility
// header) whose signed decision is administrator. `access` is what
// authorizeWorkspaceRequest already verified for this request.
export const TERMINAL_PROFILE_ADMIN_REQUIRED = 'administrator access by a signed-in user is required';

export function terminalProfileAccess(access) {
    if (access?.ok !== true || access.internal !== false || typeof access.principal !== 'string'
        || !/^user:.+/.test(access.principal) || access.canAdmin !== true) {
        return { ok: false, status: 403, error: TERMINAL_PROFILE_ADMIN_REQUIRED };
    }
    return { ok: true };
}

export async function listTerminalProfiles(store) {
    const robots = await store.list();
    return robots.map(robot => ({ id: robot.id, label: robot.name }))
        .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

async function lstatOrNull(target) {
    try { return await fs.lstat(target); } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
        throw error;
    }
}

// Read-only check that the robot's `home` child is a real directory, not a
// symlink, that the workspace data mount projects the same inode, and that its
// realpath is exactly the direct child `home` of the robot root's realpath.
export async function robotTerminalHome(store, robotId, workspaceRoot = requireWorkspaceRoot()) {
    const directory = await robotTerminalDirectory(store, robotId, workspaceRoot);
    const robotRoot = store.robotPath(robotId);
    const home = path.join(robotRoot, 'home');
    const workspaceHome = path.join(workspaceRoot, directory, 'home');
    const [actual, projected] = await Promise.all([lstatOrNull(home), lstatOrNull(workspaceHome)]);
    if (!actual || !projected || !actual.isDirectory() || actual.isSymbolicLink() || !projected.isDirectory()
        || projected.isSymbolicLink() || actual.dev !== projected.dev || actual.ino !== projected.ino) {
        throw new Error('Robot home folder is not available through the workspace mount.');
    }
    const expected = path.join(await fs.realpath(robotRoot), 'home');
    if (await fs.realpath(home) !== expected) throw new Error('Robot home folder is not a direct child of the robot.');
    return `${directory}/home`;
}

// Answers the router's read-only profile resolution. Any problem is a refusal,
// never an error response and never a change on disk.
export async function resolveTerminalProfile(store, robotId, workspaceRoot = requireWorkspaceRoot()) {
    if (typeof robotId !== 'string' || !ROBOT_ID.test(robotId)) return { allowed: false };
    try {
        const robot = await store.get(robotId);
        if (!robot || robot.id !== robotId) return { allowed: false };
        await robotTerminalHome(store, robotId, workspaceRoot);
        return { allowed: true, profile: { id: robotId, label: robot.name, home: `robots/${robotId}/home` } };
    } catch {
        return { allowed: false };
    }
}
