import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from './contracts.mjs';

export const BASELINE_REVISION = '7aea516285e29f7306cb6c5d442c23a083060ede';
export const BASELINE_METHOD = `    async _prepareRobotAgentState(robotHome) {
        await Promise.all(ROBOT_AGENT_STATE_DIRECTORIES.map(async (relativePath) => {
            const directory = path.join(robotHome, relativePath);
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            await fs.chmod(directory, 0o700);
        }));
    }`;
export const BASELINE_DIRECTORIES = `const ROBOT_AGENT_STATE_DIRECTORIES = Object.freeze([
    '.codex',
    '.config/opencode',
    '.cache/opencode',
    '.local/share/opencode',
    '.local/state/opencode',
    '.pi/agent',
]);`;

// This is the exact bounded baseline helper recipe, checked against immutable
// source. Its only arguments are newly created scratch A/B homes. It never
// receives a deployed home or starts the baseline service.
export async function baselineSymlinkControl(source) {
    assert.equal(source.split(BASELINE_METHOD).length, 2, 'Baseline helper body differs from the approved immutable recipe.');
    assert.equal(source.split(BASELINE_DIRECTORIES).length, 2, 'Baseline state directories differ from the approved immutable recipe.');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robowork-controller-negative-'));
    const rootStat = await fs.lstat(root);
    try {
        const attacker = path.join(root, 'A'); const victim = path.join(root, 'B');
        await fs.mkdir(attacker); await fs.mkdir(victim); await fs.chmod(victim, 0o755);
        await fs.symlink(victim, path.join(attacker, '.codex'), 'dir');
        const before = (await fs.stat(victim)).mode & 0o777;
        const directories = ['.codex', '.config/opencode', '.cache/opencode', '.local/share/opencode', '.local/state/opencode', '.pi/agent'];
        await Promise.all(directories.map(async relativePath => {
            const directory = path.join(attacker, relativePath);
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            await fs.chmod(directory, 0o700);
        }));
        const after = (await fs.stat(victim)).mode & 0o777;
        assert.equal(before, 0o755); assert.equal(after, 0o700, 'Baseline negative control did not reproduce victim mode mutation.');
        return { revision: BASELINE_REVISION, recipeHash: sha256(BASELINE_METHOD + BASELINE_DIRECTORIES),
            control: 'bounded exact baseline helper recipe', victimBeforeMode: before, victimAfterMode: after };
    } finally {
        const current = await fs.lstat(root);
        assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.ino === rootStat.ino && current.dev === rootStat.dev);
        await fs.rm(root, { recursive: true });
    }
}
