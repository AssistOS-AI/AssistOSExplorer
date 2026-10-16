import assert from 'node:assert/strict';
import test from 'node:test';

import { SlashCommandHandler } from '../src/repl/SlashCommandHandler.mjs';

function createHandler() {
    let mode = 'ask-for-approval';
    return new SlashCommandHandler({
        executeSkill: async () => null,
        getUserSkills: () => [],
        getSkills: () => [],
        getPermissions: async () => mode,
        setPermissions: async (next) => {
            mode = next;
            return mode;
        },
    });
}


test('/permissions rejects unknown modes', async () => {
    const handler = createHandler();
    const result = await handler.executeSlashCommand('permissions', 'unsafe');
    assert.match(result.error, /ask-for-approval\|full-access/);
});
