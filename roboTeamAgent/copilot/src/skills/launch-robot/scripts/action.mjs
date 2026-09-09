import { createRoboTeamClient } from './roboTeamClient.mjs';

const READY_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;
const MODES = new Set(['desktop', 'browser', 'cli']);

function trim(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function parseInput(promptText) {
    const text = trim(promptText);
    if (!text) throw new Error('use `desktop [robot name]: <task>` or `browser [robot name]: <task>`');
    if (text.startsWith('{')) {
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new Error('the JSON launch request is invalid');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('the JSON launch request must be an object');
        }
        return parsed;
    }
    const match = text.match(/^(desktop|browser|cli)(?:\s+([^:]+?))?\s*:\s*([\s\S]+)$/iu);
    if (!match) throw new Error('use `desktop [robot name]: <task>` or `browser [robot name]: <task>`');
    return { mode: match[1], ...(trim(match[2]) ? { robotName: match[2] } : {}), task: match[3] };
}

function normalizeRequest(promptText) {
    const input = parseInput(promptText);
    const mode = trim(input.mode).toLowerCase();
    const robotName = Object.hasOwn(input, 'robotName') ? trim(input.robotName) : 'default';
    const task = trim(input.task);
    if (!MODES.has(mode)) throw new Error('mode must be desktop, browser, or cli');
    if (!robotName) throw new Error('robotName must be a nonblank string when supplied');
    if (!task) throw new Error('task is required');
    const ca = trim(input.ca) || 'codex';
    if (!['auto', 'codex', 'opencode', 'pi'].includes(ca)) throw new Error('ca must be auto, codex, opencode, or pi');
    return {
        mode,
        robotName,
        task,
        ca,
        ...(trim(input.model) ? { model: trim(input.model) } : {}),
        ...skillSelection(input),
    };
}

function skillSelection(input) {
    const result = {};
    for (const key of ['skillSets', 'skillset', 'skills']) {
        if (input[key] === undefined) continue;
        const names = Array.isArray(input[key]) ? input[key] : typeof input[key] === 'string' ? input[key].split(',') : null;
        if (!names || names.length > 100 || names.some((name) => typeof name !== 'string' || !name.trim())) {
            throw new Error(`${key} must contain skill names as a string or array`);
        }
        if (names.length) result[key] = names.map((name) => name.trim()).join(',');
    }
    return result;
}

function workspace(invocation = {}) {
    return trim(invocation.workingDir) || process.cwd();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function remoteTaskId(started) {
    return trim(started?.metadata?.taskId || started?.result?.metadata?.taskId || started?.taskId);
}

async function waitUntilVisible(client, request, started, invocation = {}) {
    const timeoutMs = Math.max(1000, Number(invocation.readyTimeoutMs) || READY_TIMEOUT_MS);
    const pollIntervalMs = Math.max(1, Number(invocation.pollIntervalMs) || POLL_INTERVAL_MS);
    const taskId = remoteTaskId(started);
    const urlTool = request.mode === 'desktop'
        ? 'getSessionUrlForRobotDesktop'
        : 'getSessionUrlForRobotBrowser';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        let task = null;
        if (taskId && typeof client.getTaskStatus === 'function') {
            task = await client.getTaskStatus(taskId);
            const status = trim(task?.status).toLowerCase();
            if (status === 'failed' || status === 'cancelled') {
                throw new Error(trim(task?.error) || `robot task ${status}`);
            }
        }
        try {
            const urlResult = await client.call(urlTool, { robotName: request.robotName });
            const sessionUrl = trim(urlResult.sessionUrl || started.sessionUrl);
            if (sessionUrl) return { task, sessionUrl };
        } catch (error) {
            if (trim(task?.status).toLowerCase() === 'completed') throw error;
        }
        await sleep(pollIntervalMs);
    }
    throw new Error('the robot desktop or browser did not become ready in time');
}

export async function action(invocation = {}) {
    try {
        const request = normalizeRequest(invocation.promptText);
        const client = await createRoboTeamClient(invocation);
        const toolName = request.mode === 'cli' ? 'startSimpleALATaskForRobot' : request.mode === 'desktop'
            ? 'startDesktopTaskForRobot'
            : 'startBrowserTaskForRobot';
        const started = await client.call(toolName, {
            robotName: request.robotName,
            cwd: workspace(invocation),
            task: request.task,
            ca: request.ca,
            ...(request.model ? { model: request.model } : {}),
            ...(request.skillSets ? { skillSets: request.skillSets } : {}),
            ...(request.skillset ? { skillset: request.skillset } : {}),
            ...(request.skills ? { skills: request.skills } : {}),
        });
        const taskId = remoteTaskId(started);
        if (!taskId) throw new Error('RoboTeam did not return a task id');
        if (request.mode === 'cli') return `Robot CLI task ${taskId} started.`;
        const ready = await waitUntilVisible(client, request, started, invocation);
        if (!ready.sessionUrl) throw new Error('RoboTeam did not return a live session URL');
        await invocation.publishLiveSession?.(taskId, { mode: request.mode, url: ready.sessionUrl });
        return `Robot task ${taskId} started. [Open live ${request.mode}](${ready.sessionUrl})`;
    } catch (error) {
        return `Could not start the RoboTeam task: ${error?.message || 'request failed'}`;
    }
}

export const launchRobotInternals = { normalizeRequest, remoteTaskId, waitUntilVisible };
export default action;
