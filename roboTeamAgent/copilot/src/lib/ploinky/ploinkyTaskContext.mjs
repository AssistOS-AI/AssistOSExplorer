import { loadAgentClient } from '../../../../server/run-client.mjs';
import { createSanitizer } from '../skillRuntimePolicy.mjs';
import { runWithSkillRuntimeOrigin } from '../skills/skillTaskOrigin.mjs';

const TOOLS = new Map([
    ['roboTeamAgent', new Set(['roboflow_start_flow', 'roboflow_list_workflows'])],
    ['GPTResearcher', new Set(['start_research'])],
]);
const REFS = new Set(['AchillesIDE/roboTeamAgent', 'legacy-agents/GPTResearcher', 'legacy-agents/searchAgent']);
const refused = () => Object.assign(new Error('Task callback is not permitted'), { statusCode: 403 });

// Only noncredential context crosses into a robot. The controller relays the
// narrow skill calls using its own verified MCP identity.
export async function createPloinkyTaskContext({ context, robotId = null, env = process.env, onTask, createClient = null }) {
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
                // The relay sets these itself and replaces whatever a robot sends: the run's own working folder, and the calling
                // robot as the only one a workflow it starts may use.
                if (body.tool === 'roboflow_start_flow' && !robotId) throw refused();
                const forced = { roboflow_start_flow: { folder: context.workingDir, restrictToRobot: robotId }, start_research: { workingDir: context.workingDir } }[body.tool];
                const payload = forced ? { ...given, ...forced } : given;
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
