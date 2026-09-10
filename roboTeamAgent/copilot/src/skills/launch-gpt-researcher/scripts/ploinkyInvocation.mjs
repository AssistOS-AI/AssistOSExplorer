import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sendTaskEvent } from './taskEventClient.mjs';
import { spawn } from 'node:child_process';

const MAX_BYTES = 1024 * 1024;
const TARGETS = {
    'launch-gpt-researcher': 'GPTResearcher',
    'launch-robot': 'roboTeamAgent',
};

export async function createSkillInvocation({ skillName, input, contextDirectory = '/workspace/ploinky-runtime', sdk } = {}) {
    if (typeof input !== 'string') throw new TypeError('Skill input must be a string.');
    let setup;
    let standalone = false;
    try { setup = JSON.parse(await fs.readFile(path.join(contextDirectory, 'context.json'), 'utf8')); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        standalone = true;
        // Direct script use inside a Ploinky agent needs no AchillesCLI service.
        setup = { version: 1, env: {}, workingDir: process.cwd() };
    }
    if ((!standalone && setup.version !== 2) || !path.isAbsolute(setup.workingDir)) throw new Error('Invalid Ploinky task context.');
    for (const [name, value] of Object.entries(setup.env || {})) {
        if (!name.startsWith('PLOINKY_') || /MASTER|PRIVATE_SECRET|SUBJECT|PASSWORD/i.test(name) || typeof value !== 'string') {
            throw new Error('Invalid SDK environment field.');
        }
        process.env[name] = value;
    }
    const receipt = async event => {
        if (standalone) return;
        try { await sendTaskEvent(path.join(contextDirectory, 'tasks.sock'), setup.eventToken, event); }
        catch (cause) {
            throw new Error(`Task ${event.task.taskId} already started, but its notification failed. Do not launch it again.`, { cause });
        }
    };
    const clients = new Map();
    let module = sdk;
    let removeObserver;
    const load = async () => {
        if (!module) module = await import(standalone ? '/Agent/client/AgentMcpClient.mjs'
            : pathToFileURL(path.join(contextDirectory, 'sdk/client/AgentMcpClient.mjs')).href);
        if (!removeObserver) removeObserver = module.setAgentTaskObserver(async (task) => {
            await receipt({ type: 'task-started', task: {
                agentName: task.agentName, taskId: task.taskId, toolName: task.toolName,
                arguments: task.arguments, metadata: task.metadata,
            } });
            return { detached: true };
        });
        return module;
    };
    const clientFor = async (agent) => {
        if (!clients.has(agent)) clients.set(agent, (await load()).createAgentClient(agent, {
            userDelegationToken: setup.userDelegationToken || '',
        }));
        return clients.get(agent);
    };
    const target = TARGETS[skillName];
    const context = { workingDir: setup.workingDir, agentName: target,
        webchatResources: setup.resources || [], webchatPaths: setup.paths || [],
        webchatOrigin: setup.origin || {} };
    const callAgentTool = async (agent, tool, payload) => (await clientFor(agent)).callToolWithoutWait(tool, payload);
    const ensureAgentRunning = async (ref) => (await clientFor(target || ref.split('/').at(-1))).ensureAgentRunning(ref);
    const getTaskStatus = async (id) => (await clientFor(target)).getTaskStatus(id);
    return {
        promptText: input, workingDir: setup.workingDir, context,
        resources: context.webchatResources, paths: context.webchatPaths, origin: context.webchatOrigin,
        hasInvocationToken: false, hasUserDelegationToken: Boolean(setup.userDelegationToken),
        callAgentTool, ensureAgentRunning, getTaskStatus,
        agentClient: {
            callToolWithoutWait: (tool, payload) => callAgentTool(target, tool, payload),
            ensureAgentRunning, getTaskStatus,
        },
        bashExecutor: async (params = {}) => {
            const result = await executeProcess({ command: params.command, args: params.args || [], cwd: process.cwd() });
            return { success: result.success, output: result.stdout.trim(), stderr: result.stderr.trim(),
                error: result.error || null, exitCode: result.status, signal: result.signal, timedOut: result.timedOut };
        },
        async close() { removeObserver?.(); },
    };
}

export async function executeProcess({ command, args = [], cwd, env = process.env, timeoutMs = 30000 } = {}) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let completed = false;
        let killTimer;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
            killTimer.unref();
        }, timeoutMs);
        child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
        child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
        child.once('error', (error) => {
            if (completed) return;
            completed = true;
            clearTimeout(timer);
            clearTimeout(killTimer);
            resolve({ success: false, status: null, stdout, stderr, error: error.message, timedOut });
        });
        child.once('close', (status, signal) => {
            if (completed) return;
            completed = true;
            clearTimeout(timer);
            clearTimeout(killTimer);
            resolve({ success: status === 0 && !timedOut, status, signal, stdout, stderr, timedOut,
                error: timedOut ? `Command timed out after ${timeoutMs}ms.` : (status === 0 ? null : stderr.trim() || `Exit code: ${status}`) });
        });
    });
}

function appendBounded(current, chunk) {
    const next = current + chunk.toString('utf8');
    if (Buffer.byteLength(next, 'utf8') <= MAX_BYTES) return next;
    return Buffer.from(next, 'utf8').subarray(-MAX_BYTES).toString('utf8');
}
