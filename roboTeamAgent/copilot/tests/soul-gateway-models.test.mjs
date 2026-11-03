import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAlaEngine } from '../src/lib/execution/alaEngine.mjs';
import { ConversationSessionStore } from '../src/lib/storage/conversationSessionStore.mjs';
import { loadAutocompleteCatalog } from '../src/mcp/list-slash-commands.mjs';
import { prepareRobotShell } from '../../../roboWorkAgent/server/robot-shell.mjs';
import { createSoulGatewayOpenCode } from '../../../roboWorkAgent/server/soul-gateway-opencode.mjs';
import { resolveAlaCommand } from '../../server/ala-command.mjs';
import { createRunManagerRoboWork } from './helpers/robowork-run-stand-in.mjs';

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
    // The robot's selected model lives in its ALA config.
    await fs.writeFile(path.join(home, '.ala', 'config.json'), JSON.stringify({
        codingAgent: 'opencode', models: { opencode: `soul-gateway/${modelId}` }, efforts: {} }));
    const alaRoot = path.dirname(path.dirname(await fs.realpath(resolveAlaCommand())));
    const { loadConfig } = await import(pathToFileURL(path.join(alaRoot, 'src', 'config.mjs')).href);
    let prepares = 0;
    // RoboWork mounts the robot's soul directory where the installed plugin looks for the gateway socket.
    const soul = path.join(dir, 'soul');
    await fs.mkdir(soul);
    const pluginFile = path.join(home, '.config/opencode/plugins/soul-gateway.js');
    const pluginSource = await fs.readFile(pluginFile, 'utf8');
    const mounted = pluginSource.replace("'/workspace/roboteam-soul'", JSON.stringify(soul));
    assert.notEqual(mounted, pluginSource);
    await fs.writeFile(pluginFile, mounted);
    const gateway = createSoulGatewayOpenCode({
        connect: async () => ({ scope: 'robot-test', request: async () => { prepares++; return { data: [{ id: modelId }] }; } }),
    });
    await gateway.listen(path.join(soul, 'soul-gateway.sock'));
    const skills = { getSkills: () => [], async refresh() { return { skills: [], taskRepositories: [] }; } };
    // RoboWork's model operation lists models through the ALA installation it names; this one lists them through the
    // installed plugin, as OpenCode does. Model discovery mounts the canonical cwd.
    const ala = path.join(dir, 'ala');
    const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
    await write(path.join(ala, 'bin/ala.mjs'), '');
    await write(path.join(ala, 'package.json'), '{"name":"advanced-language-agent"}');
    await write(path.join(ala, 'src/config.mjs'), '');
    await write(path.join(ala, 'src/coding-agents/logins.mjs'), '');
    await write(path.join(ala, 'src/coding-agents/discovery.mjs'),
        "export const discoverCodingAgents = async () => [{ name: 'opencode', binary: '/unused/opencode', available: true }];\n");
    await write(path.join(ala, 'src/coding-agents/service.mjs'), [
        `export const createCodingAgentService = ({ env, workspace }) => {`,
        `    if (workspace !== ${JSON.stringify(dir)} || env.PLOINKY_AGENT_API_KEY !== undefined || env.OPENCODE_CONFIG_CONTENT !== undefined) throw new Error('unexpected service options');`,
        `    let plugin;`,
        `    return { async listModels(backend) {`,
        `        if (backend !== 'opencode') throw new Error('unexpected backend');`,
        `        const { SoulGateway } = await import(${JSON.stringify(pathToFileURL(pluginFile).href)});`,
        `        plugin = await SoulGateway();`,
        `        const config = {};`,
        `        await plugin.config(config);`,
        `        return Object.entries(config.provider['soul-gateway'].models).map(([id, value]) => ({ id: 'soul-gateway/' + id, label: value.name, efforts: [] }));`,
        `    }, async close() { await plugin?.dispose(); } };`,
        `};`].join('\n'));
    const configFile = path.join(home, '.ala', 'config.json');
    const roboWork = await createRunManagerRoboWork({ workspaceRoot, home,
        childEntry: fileURLToPath(new URL('./fixtures/ala-engine-child.mjs', import.meta.url)),
        robot: { config: () => loadConfig(configFile), agents: async () => [{ name: 'opencode', available: true }] },
        modelOperation: { alaEntry: path.join(ala, 'bin/ala.mjs'), soul, dataDir: path.join(dir, 'data') } });
    const installation = { loadConfig, async discoverCodingAgents() { return [{ name: 'opencode', binary: '/unused/opencode', available: true }]; } };
    const engine = createAlaEngine({ workingDir: dir, sessionStore: sessions, skillCatalog: skills,
        settings: { readAchillesSettings: () => ({}) }, execution: { robotId: 'robot-soul-1' }, roboWork });
    t.after(async () => { await engine.close(); await roboWork.close(); await gateway.close(); await fs.rm(dir, { recursive: true, force: true }); });
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
