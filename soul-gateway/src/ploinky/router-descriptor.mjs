import { pathToFileURL } from 'node:url';

const MOUNTED_DESCRIPTOR_VERIFIER = '/Agent/client/generatedRouterDescriptor.mjs';

async function defaultLoadVerifier() {
    return import(pathToFileURL(MOUNTED_DESCRIPTOR_VERIFIER).href);
}

export async function loadVerifiedPloinkyRouterDescriptor({
    env = process.env,
    loadVerifier = defaultLoadVerifier,
} = {}) {
    const verifier = await loadVerifier();
    if (
        typeof verifier?.loadVerifiedGeneratedRouterDescriptor !== 'function' ||
        typeof verifier?.resolveGeneratedRouterOperation !== 'function'
    ) {
        throw new Error('Mounted Ploinky Router descriptor verifier is unavailable.');
    }
    const descriptor = verifier.loadVerifiedGeneratedRouterDescriptor({ env });
    return Object.freeze({
        physicalOrigin: descriptor.physicalOrigin,
        requestAuthority: descriptor.requestAuthority,
        descriptorFile: descriptor.descriptorFile,
        agentPrincipal: descriptor.payload?.agentPrincipal,
        resolveOperation(absolutePath) {
            return verifier.resolveGeneratedRouterOperation(descriptor, absolutePath);
        },
    });
}

export const __routerDescriptorTestables = Object.freeze({
    MOUNTED_DESCRIPTOR_VERIFIER,
});
