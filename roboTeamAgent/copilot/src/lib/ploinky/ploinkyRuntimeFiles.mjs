import fs from 'node:fs/promises';
import path from 'node:path';

export const PLOINKY_RUNTIME_TARGET = '/workspace/ploinky-runtime';

// Copy only the SDK runtime and its JWT dependencies, never the agent's install tree.
export async function preparePloinkyRuntimeFiles(directory, env, agentRoot = '/Agent') {
    const sdkEnv = { ...env };
    if (!env.PLOINKY_AGENT_ID) return sdkEnv;
    if (!env.PLOINKY_AGENTLIB_DIR || !env.PLOINKY_ROUTER_DESCRIPTOR_FILE) {
        throw new Error('Ploinky runtime requires AgentLib and the generated Router descriptor.');
    }
    const copy = async (source, relative) => {
        const target = path.join(directory, relative);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.cp(source, target, { recursive: true, dereference: true });
    };
    await Promise.all([
        copy(path.join(agentRoot, 'client'), 'sdk/client'),
        copy(path.join(agentRoot, 'lib'), 'sdk/lib'),
        copy(path.join(env.PLOINKY_AGENTLIB_DIR, 'package.json'), 'agentlib/package.json'),
        copy(path.join(env.PLOINKY_AGENTLIB_DIR, 'jwt'), 'agentlib/jwt'),
        copy(env.PLOINKY_ROUTER_DESCRIPTOR_FILE, 'router-descriptor.json'),
    ]);
    sdkEnv.PLOINKY_AGENTLIB_DIR = path.join(PLOINKY_RUNTIME_TARGET, 'agentlib');
    sdkEnv.PLOINKY_ROUTER_DESCRIPTOR_FILE = path.join(PLOINKY_RUNTIME_TARGET, 'router-descriptor.json');
    // Preserve signed mirror values, including edgeTopologyFile. The SDK uses the
    // topology embedded in the signed descriptor, not a relocated topology file.
    return sdkEnv;
}
