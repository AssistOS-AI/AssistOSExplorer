export function fakeRouterDescriptorOptions({
    physicalOrigin,
    requestAuthority,
    agentPrincipal,
} = {}) {
    const descriptor = Object.freeze({
        physicalOrigin,
        requestAuthority,
        descriptorFile: '/test/generated-router-descriptor.json',
        payload: Object.freeze({ agentPrincipal }),
    });
    const verified = new WeakSet([descriptor]);
    return {
        descriptorEnv: Object.freeze({}),
        async loadDescriptorVerifier() {
            return {
                loadVerifiedGeneratedRouterDescriptor() {
                    return descriptor;
                },
                resolveGeneratedRouterOperation(value, absolutePath) {
                    if (!verified.has(value)) throw new Error('unverified test descriptor');
                    if (!/^\/(?!\/)[^?#\\]*$/.test(absolutePath)) {
                        throw new Error('invalid test Router operation');
                    }
                    const url = new URL(absolutePath, physicalOrigin);
                    if (url.origin !== physicalOrigin || url.pathname !== absolutePath) {
                        throw new Error('escaped test Router operation');
                    }
                    return url;
                },
            };
        },
    };
}
