import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROXY_AGENT_ENV = 'ROBOTEAM_PROXY_AGENT';
const DEFAULT_PROXY_AGENT = 'proxyAgent';
// A lease may discover the proxy's exit address and look up its locale through it.
const LEASE_TIMEOUT_MS = 60000;
const CALL_TIMEOUT_MS = 15000;
const NEUTRAL_LOCALE = Object.freeze({ timezone: 'UTC', locale: 'en_US.UTF-8', lang: 'en-US' });

function httpError(statusCode, message) {
    return Object.assign(new Error(message), { statusCode });
}

async function loadCreateAgentClient(env = process.env) {
    const agentLib = String(env.PLOINKY_AGENT_LIB_DIR || '/Agent').replace(/\/+$/u, '');
    const candidates = [path.join(agentLib, 'client/AgentMcpClient.mjs')];
    if (env.PLOINKY_WORKSPACE_ROOT) candidates.push(path.join(env.PLOINKY_WORKSPACE_ROOT, 'ploinky/Agent/client/AgentMcpClient.mjs'));
    const candidate = candidates.find(file => fs.existsSync(file));
    if (!candidate) throw new Error('Ploinky agent client is unavailable');
    return (await import(pathToFileURL(candidate).href)).createAgentClient;
}

// The shared proxy pool lives in the optional proxyAgent; RoboTeam leases one proxy per robot from
// it through the Router and keeps the relay, the Chromium policy and the firewall here. A missing
// or unreachable proxyAgent, like a pool without usable proxies, means a direct connection: robots
// must keep working without proxies. Only an active pool with nothing free stops a workstation.
export class ProxyAgentClient {
    constructor({ agentName = process.env[PROXY_AGENT_ENV] || DEFAULT_PROXY_AGENT, createClient = null, log = (line) => console.warn(`[roboTeamAgent] ${line}`) } = {}) {
        this.agentName = agentName;
        this.createClient = createClient;
        this.log = log;
    }

    async _call(tool, args, timeoutMs) {
        const create = this.createClient || await loadCreateAgentClient();
        const client = await create(this.agentName);
        const result = await client.callTool(tool, args, { timeoutMs });
        if (!result || typeof result !== 'object') throw new Error(`${this.agentName} gave an unreadable answer`);
        return result;
    }

    // The upstream proxy and the locale of its exit address, or null for a direct connection. The
    // robot name only labels the lease on proxyAgent's page.
    async lease(robotId, robotName = '') {
        let result;
        try {
            const label = String(robotName || '').slice(0, 80);
            result = await this._call('proxy_lease', label ? { subject: robotId, label } : { subject: robotId }, LEASE_TIMEOUT_MS);
        } catch (error) {
            this.log(`proxy pool unavailable, ${robotId} connects directly: ${error?.message || error}`);
            return null;
        }
        if (result.ok === false && result.status === 409) throw httpError(409, result.error);
        if (result.ok === false) {
            this.log(`proxy pool refused ${robotId}, which connects directly: ${result.error || 'unknown error'}`);
            return null;
        }
        if (result.active !== true) return null;
        const proxy = result.proxy || {};
        if (proxy.scheme !== 'http' || !proxy.host || !Number.isInteger(proxy.port)) {
            this.log(`proxy pool gave ${robotId} an unusable proxy; it connects directly`);
            return null;
        }
        return { upstream: proxy, locale: { ...NEUTRAL_LOCALE, ...(result.locale || {}) } };
    }

    async release(robotId) {
        try {
            const result = await this._call('proxy_release', { subject: robotId }, CALL_TIMEOUT_MS);
            return result.released === true;
        } catch (error) {
            this.log(`could not release the proxy of ${robotId}: ${error?.message || error}`);
            return false;
        }
    }

    // What each robot holds, without credentials; every robot of RoboTeam without a list. available
    // is false when proxyAgent is missing or unreachable, which the dashboard shows instead of an
    // empty pool.
    async assignments(robotIds = null) {
        try {
            const result = await this._call('proxy_assignments', robotIds ? { subjects: robotIds } : {}, CALL_TIMEOUT_MS);
            if (result.ok === false) return { available: false, active: false, assignments: [] };
            return { available: true, active: result.active === true, assignments: Array.isArray(result.assignments) ? result.assignments : [] };
        } catch {
            return { available: false, active: false, assignments: [] };
        }
    }
}
