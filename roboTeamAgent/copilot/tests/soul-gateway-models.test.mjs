import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAlaEngine } from '../src/lib/alaEngine.mjs';
import { ConversationSessionStore } from '../src/lib/conversationSessionStore.mjs';
import { loadAutocompleteCatalog } from '../src/mcp/list-slash-commands.mjs';
import { prepareRobotShell } from '../../server/robot-shell.mjs';
import { createSoulGatewayOpenCode } from '../../server/soul-gateway-opencode.mjs';

test('webchat autocomplete and robot execution receive the same dynamic OpenCode provider', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-soul-models-'));
    const home = path.join(dir, 'home');
    const workspaceRoot = path.dirname(dir);
    await fs.mkdir(home);
    await prepareRobotShell(home);
    const previousHome = process.env.ACHILLES_ALA_HOME;
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.ACHILLES_ALA_HOME = home;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    t.after(() => {
        if (previousHome === undefined) delete process.env.ACHILLES_ALA_HOME;
        else process.env.ACHILLES_ALA_HOME = previousHome;
        if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    });
    const sessions = new ConversationSessionStore({ workingDir: dir });
    const session = await sessions.createSession();
    let modelId = 'provider-a/model-from-gateway';
    let prepares = 0;
    const gateway = createSoulGatewayOpenCode({
        connect: async () => ({ scope: 'robot-test', request: async () => { prepares++; return { data: [{ id: modelId }] }; } }),
    });
    await gateway.listen(path.join(home, '.config/opencode/soul-gateway.sock'));
    const { SoulGateway } = await import(pathToFileURL(path.join(home, '.config/opencode/plugins/soul-gateway.js')));
    const skills = { getSkills: () => [], async refresh() { return { skills: [], taskRepositories: [] }; } };
    const installation = {
        entryPath: fileURLToPath(new URL('./fixtures/ala-engine-child.mjs', import.meta.url)),
        async discoverCodingAgents() { return [{ name: 'opencode', binary: '/unused/opencode', available: true }]; },
        createCodingAgentService({ env, workspace }) {
            // Model discovery mounts the canonical cwd and the robot home, so the
            // robot-home Soul Gateway socket resolves inside the sandbox.
            assert.equal(workspace, dir);
            assert.equal(env.PLOINKY_AGENT_API_KEY, undefined);
            assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
            let plugin;
            return { async listModels(backend) {
                assert.equal(backend, 'opencode');
                plugin = await SoulGateway();
                const config = {};
                await plugin.config(config);
                return Object.entries(config.provider['soul-gateway'].models).map(([id, value]) => ({ id: `soul-gateway/${id}`, label: value.name, efforts: [] }));
            }, async close() { await plugin?.dispose(); } };
        },
    };
    const engine = createAlaEngine({ workingDir: dir, sessionStore: sessions, skillCatalog: skills,
        installation, settings: { readAchillesSettings: () => ({}),
            getCodingAgentModels: () => ({ opencode: `soul-gateway/${modelId}` }) } });
    t.after(async () => { await engine.close(); await gateway.close(); await fs.rm(dir, { recursive: true, force: true }); });
    await engine.getModel({ sessionId: session.sessionId });
    assert.equal(prepares, 0, 'Reading the selected model does not fetch the catalog');
    const autocomplete = await loadAutocompleteCatalog({ dir, sessionId: session.sessionId,
        engine, installation, skillCatalog: skills });
    const command = autocomplete.commands.find((item) => item.name === '/model');
    assert.ok(command.subCommands.some((item) => item.name === `soul-gateway/${modelId}`));
    const first = JSON.parse((await engine.executeTurn({ sessionId: session.sessionId, prompt: 'First' })).outputText);
    assert.deepEqual(first.openCodeModels, [modelId]);
    assert.equal(first.model, `soul-gateway/${modelId}`);
    modelId = 'new-provider/new-model';
    const second = JSON.parse((await engine.executeTurn({ sessionId: session.sessionId, prompt: 'Next' })).outputText);
    assert.deepEqual(second.openCodeModels, [modelId]);
    assert.equal(second.resumed, true);
});
