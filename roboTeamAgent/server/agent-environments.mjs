import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REF = /^[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,128}$/u;

export function isEnvironmentRef(value) {
    return typeof value === 'string' && REF.test(value) && value.split('/').every(part => part !== '.' && part !== '..');
}

async function defaultCall(tool, input, options) {
    const agentLib = process.env.PLOINKY_AGENT_LIB_DIR || '/Agent';
    const { createAgentClient } = await import(pathToFileURL(path.join(agentLib, 'client/AgentMcpClient.mjs')).href);
    const client = await createAgentClient('roboWorkAgent');
    return client.callTool(tool, input, options);
}

// RoboWork owns discovery and execution. RoboTeam only validates the user's selection.
export class AgentEnvironments {
    constructor({ call = defaultCall } = {}) {
        this.call = call;
    }

    async list() {
        const result = await this.call('environment_list', {}, { timeoutMs: 120000 });
        if (!Array.isArray(result)) throw new Error('RoboWork gave an unreadable environment list');
        return result;
    }

    async require(ref) {
        if (!isEnvironmentRef(ref)) throw Object.assign(new Error('Invalid agent environment'), { code: 'ENVIRONMENT_INVALID', statusCode: 400 });
        const entry = (await this.list()).find(item => item.ref === ref);
        if (!entry || !entry.available && entry.reason !== 'image cannot be pulled') throw Object.assign(new Error(`Agent environment unavailable: ${entry?.reason || 'not enabled in global mode'}`),
            { code: 'ENVIRONMENT_UNAVAILABLE', statusCode: 409 });
        return entry;
    }
}
