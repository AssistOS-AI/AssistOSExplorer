import fs from 'node:fs/promises';
import path from 'node:path';

export async function robotTerminalDirectory(store, robotId, workspaceRoot = '/workspace') {
    const home = path.join(store.robotPath(robotId), 'home');
    const directory = `.data/roboTeamAgent/robots/${robotId}/home`;
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
