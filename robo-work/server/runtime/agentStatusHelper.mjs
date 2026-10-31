// Fixed worker workload entrypoint. Only this sandbox reads the robot HOME or starts version commands.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { discoverCodingAgents } from './ala/src/coding-agents/discovery.mjs';
import { detectCodingAgentLogins, homeEnvironment } from './ala/src/coding-agents/logins.mjs';

export async function collectAgentStatus(env) {
    const agents = await discoverCodingAgents({ env });
    const logins = await detectCodingAgentLogins({ env });
    const run = promisify(execFile);
    const result = await Promise.all(agents.map(async (agent) => {
        let version = null;
        if (agent.available) {
            try {
                const { stdout } = await run(agent.binary, ['--version'], { env, cwd: env.HOME, timeout: 3000, maxBuffer: 4096 });
                // Publish only a version token, never arbitrary backend output.
                version = stdout.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?\b/u)?.[0] ?? null;
            } catch { /* installation remains visible without a version */ }
        }
        return { name: agent.name, available: agent.available, loggedIn: logins[agent.name].loggedIn, version };
    }));
    return { agents: result };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.stdout.write(`${JSON.stringify(await collectAgentStatus(homeEnvironment(process.env, '/home/robot')))}\n`);
}
