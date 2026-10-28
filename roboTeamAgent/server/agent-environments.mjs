import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The Ploinky agents a terminal workflow phase may run in: every enabled agent that runs in global
// mode (it mounts the workspace at the same path, so the robot home, the project and the tool cache
// are visible to it) in a podman container. The robot's ALA and coding agent run inside that
// agent's container through the Router's agent-exec route; RoboTeam itself is the default.

const REF = /^[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,128}$/u;

async function defaultMarketplace(env = process.env) {
    const agentLib = String(env.PLOINKY_AGENT_LIB_DIR || '/Agent').replace(/\/+$/u, '');
    const candidates = [path.join(agentLib, 'client/AgentMcpClient.mjs')];
    if (env.PLOINKY_WORKSPACE_ROOT) candidates.push(path.join(env.PLOINKY_WORKSPACE_ROOT, 'ploinky/Agent/client/AgentMcpClient.mjs'));
    const candidate = candidates.find(file => fs.existsSync(file));
    if (!candidate) throw new Error('Ploinky agent client is unavailable');
    const { requestMarketplace } = await import(pathToFileURL(candidate).href);
    return requestMarketplace('GET', null, undefined, 'agents');
}

export function isEnvironmentRef(value) {
    return typeof value === 'string' && REF.test(value);
}

// Only agents enabled in global mode are listed; one of them may still be unusable right now.
const isEnabledGlobal = agent => Boolean(agent.active) && String(agent.enableMode || '') === 'global';

function unavailableReason(agent) {
    if (agent.runtime && agent.runtime !== 'podman') return `runs on ${agent.runtime}`;
    if (!agent.running) return 'not running';
    return '';
}

export class AgentEnvironments {
    constructor({ loadMarketplace = defaultMarketplace, selfId = process.env.PLOINKY_AGENT_ID || '', ttlMs = 15000, now = Date.now } = {}) {
        Object.assign(this, { loadMarketplace, selfRef: String(selfId).replace(/^agent:/u, ''), ttlMs, now });
        this.cached = null;
    }

    // [{ ref, name, repo, about, available, reason }] for every agent enabled in global mode except RoboTeam.
    async list({ fresh = false } = {}) {
        if (!fresh && this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.value;
        const marketplace = await this.loadMarketplace();
        const seen = new Set();
        const value = (marketplace?.agents || [])
            .map(agent => ({ ...agent, ref: `${agent.repo}/${agent.name}` }))
            .filter(agent => isEnabledGlobal(agent) && isEnvironmentRef(agent.ref) && agent.ref !== this.selfRef
                && !seen.has(agent.ref) && seen.add(agent.ref))
            .map(agent => {
                const reason = unavailableReason(agent);
                return { ref: agent.ref, name: String(agent.name), repo: String(agent.repo), about: String(agent.about || ''),
                    available: !reason, reason };
            })
            .sort((a, b) => Number(b.available) - Number(a.available) || a.ref.localeCompare(b.ref));
        this.cached = { at: this.now(), value };
        return value;
    }

    // The environment for a phase, or an error that names why it cannot be used now.
    async require(ref) {
        if (!isEnvironmentRef(ref)) throw Object.assign(new Error(`Invalid agent environment: ${ref}`), { statusCode: 400 });
        const entry = (await this.list({ fresh: true })).find(item => item.ref === ref);
        if (!entry) throw Object.assign(new Error(`Agent environment ${ref} is not enabled in global mode`), { statusCode: 409 });
        if (!entry.available) throw Object.assign(new Error(`Agent environment ${ref} cannot run robot phases: ${entry.reason}`), { statusCode: 409 });
        return entry;
    }
}
