import { loadAgentClient } from '../../../../server/run-client.mjs';
import { createSanitizer } from '../skillRuntimePolicy.mjs';
import { runWithSkillRuntimeOrigin } from '../skills/skillTaskOrigin.mjs';

const TOOLS = new Map([
    ['roboTeamAgent', new Set(['roboflow_start_flow', 'roboflow_list_workflows'])],
    ['GPTResearcher', new Set(['start_research'])],
]);
// The payload field that names a folder. The relay sets it to the run's own working folder, so a robot cannot start work elsewhere.
const FOLDER_FIELD = { roboflow_start_flow: 'folder', start_research: 'workingDir' };
const REFS = new Set(['AchillesIDE/roboTeamAgent', 'legacy-agents/GPTResearcher', 'legacy-agents/searchAgent']);
const refused = () => Object.assign(new Error('Task callback is not permitted'), { statusCode: 403 });

// Only noncredential context crosses into a robot. The controller relays the
// narrow skill calls using its own verified MCP identity.
export async function createPloinkyTaskContext({ context, env = process.env, onTask, createClient = null }) {
    const sanitize = createSanitizer(context, env);
    const clients = new Map();
    const clientFor = async agent => {
        if (!clients.has(agent)) clients.set(agent, await (createClient || await loadAgentClient())(agent));
        return clients.get(agent);
    };
    const launched = new Map();
    return {
        context: sanitize({ version: 3, workingDir: context.workingDir,
            resources: context.resources || [], paths: context.paths || [], origin: context.origin || {} }),
        async dispatch({ path, body }) {
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw refused();
            if (path === '/agent-call') {
                if (!TOOLS.get(body.agent)?.has(body.tool)) throw refused();
                const given = body.payload ?? {};
                if (!given || typeof given !== 'object' || Array.isArray(given)) throw refused();
                const payload = FOLDER_FIELD[body.tool] ? { ...given, [FOLDER_FIELD[body.tool]]: context.workingDir } : given;
                const result = await runWithSkillRuntimeOrigin(context, async () =>
                    (await clientFor(body.agent)).callToolWithoutWait(body.tool, payload));
                const taskId = result?.metadata?.taskId || result?.result?.metadata?.taskId;
                if (taskId) {
                    const task = { agentName: body.agent, taskId, toolName: body.tool,
                        arguments: payload, metadata: result.metadata || {} };
                    launched.set(task.taskId, task);
                    await onTask?.(sanitize(task));
                }
                return result;
            }
            if (path === '/ensure-agent') {
                if (!REFS.has(body.ref)) throw refused();
                return (await clientFor(body.ref.split('/').at(-1))).ensureAgentRunning(body.ref);
            }
            if (path === '/task-status') {
                if (!TOOLS.has(body.agent) || typeof body.taskId !== 'string') throw refused();
                return (await clientFor(body.agent)).getTaskStatus(body.taskId);
            }
            if (path === '/task-started') {
                const task = body.task;
                if (!task || !TOOLS.get(task.agentName)?.has(task.toolName) || typeof task.taskId !== 'string') throw refused();
                const status = await (await clientFor(task.agentName)).getTaskStatus(task.taskId);
                if (!status || status.status === 'not_found' || status.isError || status.ok === false) throw refused();
                await onTask?.(sanitize({ ...(launched.get(task.taskId) || task), metadata: task.metadata || {} }));
                return { ok: true };
            }
            throw refused();
        },
        async close() {},
    };
}
