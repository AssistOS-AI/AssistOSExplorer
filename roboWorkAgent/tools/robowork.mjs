import { pathToFileURL } from 'node:url';
import { authorizeCaller } from '../server/caller.mjs';
import { fail } from '../server/robot-paths.mjs';

// The service is not listening yet (AgentServer answers MCP before the service finishes starting) or is going away.
const SERVICE_DOWN = new Set(['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET']);

function serviceDown(error) {
    const seen = new Set();
    for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
        seen.add(cause);
        if (SERVICE_DOWN.has(cause.code)) return true;
    }
    return false;
}

export async function invoke(payload, operation, { fetchImpl = fetch, env = process.env } = {}) {
    authorizeCaller(payload, env.ROBOWORK_CONTROLLER_ID || 'agent:AchillesIDE/roboTeamAgent');
    if ((payload.tool || payload.toolName || payload.name) && (payload.tool || payload.toolName || payload.name) !== operation) throw fail('INVALID_INPUT', 'Tool identity mismatch');
    const token = env.ROBOWORK_INTERNAL_TOKEN;
    if (!token) throw fail('SERVICE_UNAVAILABLE', 'RoboWork service is unavailable', 503);
    let response;
    try {
        response = await fetchImpl(`http://127.0.0.1:${Number(env.ROBOWORK_SERVICE_PORT || 3001)}/internal/${operation}`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-robowork-internal-token': token },
            body: JSON.stringify(payload.input || payload.arguments || {}), signal: AbortSignal.timeout(operation === 'robot_models' ? 95000 : 180000),
        });
    } catch (error) {
        // Typed, so a caller can tell a starting or stopping RoboWork from a refused request.
        if (serviceDown(error)) throw fail('SERVICE_UNAVAILABLE', 'RoboWork service is unavailable', 503);
        throw error;
    }
    const result = await response.json();
    if (!response.ok) throw fail(result.code || 'SERVICE_ERROR', result.error || 'RoboWork request failed', response.status);
    return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        let bytes = 0, text = '';
        for await (const chunk of process.stdin) {
            bytes += chunk.length;
            if (bytes > 2 * 1024 * 1024) throw fail('INVALID_INPUT', 'Tool payload is too large');
            text += chunk;
        }
        const result = await invoke(JSON.parse(text || '{}'), process.argv[2]);
        process.stdout.write(JSON.stringify(result) + '\n');
    } catch (error) {
        process.stderr.write(JSON.stringify({ code: error.code || 'INVALID_INPUT', error: error.statusCode ? error.message : 'RoboWork tool failed', statusCode: error.statusCode }) + '\n');
        process.exitCode = 1;
    }
}
