import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { homeTarget, fail } from './robot-paths.mjs';
import { nativeEnvironment } from './native-environment.mjs';

const execFileAsync = promisify(execFile);
const codeRoot = fileURLToPath(new URL('..', import.meta.url));

// The service never traverses a home. The helper receives exactly one home and no workspace.
export function createHomeOperations({ paths, alaEntry, toolCache, execFileImpl = execFileAsync, bwrap = 'bwrap' }) {
    return async (id, operation, input = {}) => {
        const target = homeTarget(id);
        const alaRoot = path.dirname(path.dirname(alaEntry));
        const env = nativeEnvironment({ PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', ...input.runtimeEnv }, target);
        const args = ['--die-with-parent', '--unshare-all', '--new-session', '--clearenv'];
        for (const root of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc']) {
            try { await fs.access(root); args.push('--ro-bind', root, root); } catch { /* Optional system root. */ }
        }
        args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/home',
            '--bind', paths.home(id), target, '--ro-bind', codeRoot, '/code', '--ro-bind', alaRoot, '/opt/ala',
            '--ro-bind', toolCache.root, toolCache.root);
        for (const [key, value] of Object.entries(env)) args.push('--setenv', key, value);
        args.push('--setenv', 'ROBOWORK_HELPER', '1', '--setenv', 'ROBOWORK_ALA_ENTRY', '/opt/ala/bin/ala.mjs',
            '--chdir', target, '--', process.execPath, '/code/server/home-op.mjs', operation, JSON.stringify(input));
        try {
            const result = await execFileImpl(bwrap, args, { env, timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
            return JSON.parse(result.stdout);
        } catch (error) { throw fail('HOME_OPERATION_FAILED', 'Robot home operation failed', 500); }
    };
}

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Without ALA the saved choice is read directly. An unsafe path or a file ALA would reject still fails, so a refused home never looks empty.
async function savedCodingAgent(home, agentConfigPath, names) {
    const file = await agentConfigPath(home);
    let config;
    try { config = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    // The same rules as ALA's own loadConfig.
    const agents = [...names, 'omp'];
    const models = config?.models ?? {};
    const efforts = config?.efforts ?? {};
    const valid = isRecord(config) && Object.keys(config).every(key => ['codingAgent', 'models', 'efforts'].includes(key))
        && (config.codingAgent == null || agents.includes(config.codingAgent))
        && isRecord(models) && Object.entries(models).every(([name, model]) => agents.includes(name) && typeof model === 'string' && model.trim())
        && isRecord(efforts) && Object.entries(efforts).every(([name, effort]) => agents.includes(name) && typeof models[name] === 'string'
            && typeof effort === 'string' && /^[a-zA-Z0-9_-]+$/u.test(effort));
    if (!valid) throw new Error('Invalid ALA model configuration');
    return config.codingAgent;
}

export async function homeOperation(operation, input, home = process.env.HOME) {
    if (operation === 'delete') {
        for (const entry of await fs.readdir(home)) await fs.rm(path.join(home, entry), { recursive: true, force: true });
        return { ok: true };
    }
    const { prepareRobotShell } = await import('./robot-shell.mjs');
    const { ensureAgentConfig, DEFAULT_OPENCODE_MODEL, agentConfigPath } = await import('./agent-model-config.mjs');
    const { resolveAlaInstallation } = await import('./ala-installation.mjs');
    const { CODING_AGENT_NAMES, normalizeCodingAgents } = await import('./coding-agents.mjs');
    if (operation === 'desktop-launchers') {
        const { prepareDesktopLaunchers } = await import('./desktop-launchers.mjs');
        return await prepareDesktopLaunchers(home, input) || { ok: true };
    }
    if (operation === 'ensure' || operation === 'shell') {
        await prepareRobotShell(home, input);
        return { homeTarget: home };
    }
    if (operation === 'config_set') return { record: await ensureAgentConfig(home, input) };
    // Only the status listing outlives an unavailable ALA, and only for that reason.
    let api;
    let unavailable = false;
    try { api = await resolveAlaInstallation({ entry: process.env.ROBOWORK_ALA_ENTRY }); }
    catch (error) { if (operation !== 'status') throw error; unavailable = true; }
    if (operation === 'status') {
        const enabled = input.codingAgents === undefined ? CODING_AGENT_NAMES : normalizeCodingAgents(input.codingAgents);
        const configured = unavailable ? await savedCodingAgent(home, agentConfigPath, CODING_AGENT_NAMES) : (await api.loadConfig(await agentConfigPath(home))).codingAgent;
        const activeAgent = enabled.includes(configured) ? configured : enabled[0];
        if (unavailable) return { activeAgent, alaUnavailable: true,
            ...(input.includeLogins ? { logins: Object.fromEntries(CODING_AGENT_NAMES.map(name => [name, false])) } : {}) };
        const logins = input.includeLogins ? Object.fromEntries(await Promise.all(CODING_AGENT_NAMES.map(async name =>
            [name, Boolean((await api.detectCodingAgentLogin(name, { env: process.env })).loggedIn)]))) : undefined;
        return { activeAgent, ...(logins ? { logins } : {}) };
    }
    const config = await api.loadConfig(await agentConfigPath(home));
    const agents = await api.discoverCodingAgents({ env: process.env });
    if (operation === 'config') return { homeTarget: home, ...config, defaultModels: { opencode: DEFAULT_OPENCODE_MODEL },
        agents: agents.map(({ name, available }) => ({ name, available })) };
    throw fail('INVALID_INPUT', 'Unknown home operation');
}

if (process.env.ROBOWORK_HELPER === '1' && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try { process.stdout.write(JSON.stringify(await homeOperation(process.argv[2], JSON.parse(process.argv[3] || '{}')))); }
    catch { process.stderr.write('Robot home operation failed\n'); process.exitCode = 1; }
}
