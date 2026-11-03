import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const MAX_BYTES = 1024 * 1024;
const TARGETS = { 'launch-workflow': 'roboTeamAgent', 'list-workflows': 'roboTeamAgent', 'launch-gpt-researcher': 'GPTResearcher' };

export async function createSkillInvocation({ skillName, input, contextDirectory = '/workspace/ploinky-runtime' } = {}) {
    if (typeof input !== 'string') throw new TypeError('Skill input must be a string.');
    const setup = JSON.parse(await fs.readFile(path.join(contextDirectory, 'context.json'), 'utf8'));
    if (!path.isAbsolute(setup.workingDir) || typeof setup.token !== 'string') throw new Error('Invalid task callback context.');
    const request = (pathname, body) => new Promise((resolve, reject) => {
        const req = http.request({ socketPath: path.join(contextDirectory, 'request.sock'), path: pathname, method: 'POST',
            headers: { 'content-type': 'application/json', 'x-task-capability': setup.token } }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > MAX_BYTES) req.destroy(new Error('Callback response is too large')); });
            res.once('end', () => {
                try {
                    const value = JSON.parse(text);
                    if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(value.error || 'Task callback refused');
                    resolve(value);
                } catch (error) { reject(error); }
            });
        });
        req.setTimeout(120000, () => req.destroy(new Error('Task callback timed out')));
        req.once('error', reject);
        req.end(JSON.stringify(body));
    });
    const target = TARGETS[skillName];
    const launched = new Map();
    const callAgentTool = async (agent, tool, payload) => {
        const result = await request('/agent-call', { agent, tool, payload });
        const taskId = result?.metadata?.taskId || result?.result?.metadata?.taskId;
        if (taskId) launched.set(taskId, { agentName: agent, taskId, toolName: tool, arguments: payload, metadata: result.metadata || {} });
        return result;
    };
    const ensureAgentRunning = ref => request('/ensure-agent', { ref });
    const getTaskStatus = taskId => request('/task-status', { agent: target, taskId });
    const context = { workingDir: setup.workingDir, agentName: target,
        webchatResources: setup.resources || [], webchatPaths: setup.paths || [], webchatOrigin: setup.origin || {} };
    return {
        promptText: input, workingDir: setup.workingDir, context,
        resources: context.webchatResources, paths: context.webchatPaths, origin: context.webchatOrigin,
        hasInvocationToken: false, hasUserDelegationToken: false,
        callAgentTool, ensureAgentRunning, getTaskStatus,
        async publishLiveSession(taskId, liveSession) {
            const task = launched.get(taskId);
            if (!task) throw new Error('Unknown launched task.');
            await request('/task-started', { task: { ...task, metadata: { ...task.metadata, liveSession } } });
        },
        agentClient: { callToolWithoutWait: (tool, payload) => callAgentTool(target, tool, payload), ensureAgentRunning, getTaskStatus },
        bashExecutor: async (params = {}) => {
            const result = await executeProcess({ command: params.command, args: params.args || [], cwd: process.cwd() });
            return { success: result.success, output: result.stdout.trim(), stderr: result.stderr.trim(),
                error: result.error || null, exitCode: result.status, signal: result.signal, timedOut: result.timedOut };
        },
        async close() {},
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
