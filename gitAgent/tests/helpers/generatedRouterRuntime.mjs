import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const runtimeHelperUrl = new URL('../../../../ploinky/tests/helpers/generatedRouterRuntime.mjs', import.meta.url).href;
const workspaceInitializerUrl = new URL('../../../../ploinky/ploinky-box/entrypoint/initialize-workspace.mjs', import.meta.url).href;

export async function withGitAgentRuntime(env, operation) {
    const previous = new Map();
    function setEnv(values) {
        for (const [name, value] of Object.entries(values)) {
            if (!previous.has(name)) previous.set(name, process.env[name]);
            if (value == null) delete process.env[name];
            else process.env[name] = value;
        }
    }

    setEnv(env);
    let runtimeDir;
    try {
        if (env.PLOINKY_ROUTER_URL && env.PLOINKY_AGENT_PRINCIPAL) {
            runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-agent-router-test-'));
            const runtimeOptions = {
                origin: env.PLOINKY_ROUTER_URL,
                tempDir: runtimeDir,
                agentPrincipal: env.PLOINKY_AGENT_PRINCIPAL,
                publicAuthority: env.PLOINKY_ROUTER_AUTHORITY || new URL(env.PLOINKY_ROUTER_URL).host,
            };
            // The signer captures its workspace at import time. Isolate its
            // controller-owned key in this fixture, not the test checkout.
            const { stdout } = await execFileAsync(process.execPath, [
                '--input-type=module', '--eval',
                `import { initializeWorkspaceMasterKey } from ${JSON.stringify(workspaceInitializerUrl)};
import { installGeneratedRouterRuntime } from ${JSON.stringify(runtimeHelperUrl)};
initializeWorkspaceMasterKey({workspaceRoot: JSON.parse(process.argv[1]).tempDir});
process.stdout.write(JSON.stringify(installGeneratedRouterRuntime(JSON.parse(process.argv[1])).env));`,
                JSON.stringify(runtimeOptions),
            ], {
                cwd: runtimeDir,
                env: {
                    ...process.env,
                    PLOINKY_MASTER_KEY: 'e'.repeat(64),
                    PLOINKY_WORKSPACE_ROOT: runtimeDir,
                    PLOINKY_CWD: runtimeDir,
                },
            });
            setEnv(JSON.parse(stdout));
        }
        return await operation();
    } finally {
        for (const [name, value] of previous) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        if (runtimeDir) await fs.rm(runtimeDir, { recursive: true, force: true });
    }
}
