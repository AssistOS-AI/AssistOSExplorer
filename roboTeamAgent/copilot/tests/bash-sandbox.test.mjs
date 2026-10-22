import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { action as runBashSkill } from '../src/skills/bash/scripts/action.mjs';
import { executeProcess } from '../src/skills/bash/scripts/ploinkyInvocation.mjs';

 test('Bash skill preserves quoted argv and workspace globs without interpreting shell operators', async (t) => {
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-bash-argv-'));
    t.after(() => fs.rmSync(workingDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workingDir, 'b.txt'), 'b');
    fs.writeFileSync(path.join(workingDir, 'a.txt'), 'a');
    const result = await runBashSkill({
        promptText: `"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" "two words" escaped\\ space | > output.txt *.txt`,
        workingDir,
        bashExecutor: async (params) => {
            const execution = await executeProcess({ ...params, cwd: workingDir });
            return { ...execution, output: execution.stdout };
        },
    });
    assert.deepEqual(JSON.parse(result), ['two words', 'escaped space', '|', '>', 'output.txt', 'a.txt', 'b.txt']);
    assert.equal(fs.existsSync(path.join(workingDir, 'output.txt')), false);
});

test('Bash skill fails closed when the sandboxed executor is unavailable', async () => {
    const result = await runBashSkill({ promptText: 'echo hello' });
    assert.match(result, /sandboxed Bash executor is unavailable/i);
});

test('Bash reports an actual unsuccessful child as an execution error', async () => {
    const result = await runBashSkill({
        promptText: '/usr/bin/false',
        bashExecutor: async (params) => {
            const execution = await executeProcess(params);
            return { ...execution, output: execution.stdout };
        },
    });
    assert.match(result, /^Error:/u);
});
