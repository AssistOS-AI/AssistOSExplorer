import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// Keep generated credentials in the wrapper and use the certified Router transport.
export async function soulGatewayConnection(env = process.env) {
    if (!env.PLOINKY_ROUTER_DESCRIPTOR_FILE) return null;
    if (!env.PLOINKY_AGENTLIB_DIR) throw new Error('Soul Gateway requires the Ploinky AgentLib runtime.');
    const root = path.join(env.PLOINKY_AGENTLIB_DIR, 'utils/LLMProviders/transport');
    const [descriptors, transport] = await Promise.all([
        import(pathToFileURL(path.join(root, 'generatedLocalRouterDescriptor.mjs')).href),
        import(pathToFileURL(path.join(root, 'routerHttpTransport.mjs')).href),
    ]);
    const descriptor = descriptors.loadGeneratedLocalRouterDescriptor({ env });
    if (!descriptor) throw new Error('Soul Gateway requires a verified Router descriptor.');
    descriptors.buildGeneratedLocalOperationURL(descriptor, descriptors.GENERATED_LOCAL_MODELS_PATH);
    const credential = env.PLOINKY_AGENT_API_KEY;
    if (!credential) throw new Error('Soul Gateway runtime credential is unavailable.');
    const scope = createHash('sha256').update(JSON.stringify(descriptor.payload)).update(credential).digest('hex');
    return {
        scope,
        async request(operation, json, signal) {
            const current = descriptors.refreshGeneratedLocalRouterDescriptor(descriptor, { env });
            const pathname = operation === 'models' ? descriptors.GENERATED_LOCAL_MODELS_PATH
                : operation === 'chat' ? descriptors.GENERATED_LOCAL_CHAT_PATH : null;
            if (!pathname) throw new Error('Unsupported Soul Gateway operation.');
            descriptors.buildGeneratedLocalOperationURL(current, pathname);
            const response = await transport.routerHttpRequest({ descriptor: current, pathname,
                method: operation === 'models' ? 'GET' : 'POST',
                bearer: env.PLOINKY_AGENT_API_KEY, json, signal,
                totalTimeoutMs: operation === 'models' ? 15000 : 510000 });
            if (!response.ok) {
                await response.readErrorText();
                throw Object.assign(new Error(`Soul Gateway returned HTTP ${response.status}.`), { status: response.status });
            }
            return response.json();
        },
    };
}
