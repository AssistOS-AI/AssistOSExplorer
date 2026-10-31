import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Real fixed helper + real pinned ALA detection code; fake installed executable only. This is not a live sandbox claim.
test('status helper emits a fixed projection and strips arbitrary version stdout', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-status-helper-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const alaCommand = process.env.ACHILLES_ALA_COMMAND;
    assert.ok(alaCommand, 'ACHILLES_ALA_COMMAND selects the pinned ALA entrypoint');
    await fs.symlink(path.dirname(path.dirname(alaCommand)), path.join(root, 'ala'));
    const helper = path.join(root, 'agentStatusHelper.mjs');
    await fs.copyFile(fileURLToPath(new URL('../../server/runtime/agentStatusHelper.mjs', import.meta.url)), helper);
    const executable = path.join(root, 'codex');
    await fs.writeFile(executable, '#!/bin/sh\nprintf "codex-cli 1.2.3 arbitrary-private-output\\n"\n', { mode: 0o700 });
    const { collectAgentStatus } = await import(pathToFileURL(helper));
    const result = await collectAgentStatus({ PATH: '', HOME: root, CODEX_BIN: executable });
    const stdout = JSON.stringify(result);
    assert.deepEqual(result.agents.map((entry) => entry.name), ['codex', 'opencode', 'pi', 'claude']);
    assert.equal(result.agents[0].version, '1.2.3');
    assert.equal(result.agents[0].available, true);
    assert.equal(stdout.includes('private'), false);
    assert.equal(stdout.includes(root), false);
    assert.equal(result.agents.every((entry) => typeof entry.loggedIn === 'boolean'), true);
});
