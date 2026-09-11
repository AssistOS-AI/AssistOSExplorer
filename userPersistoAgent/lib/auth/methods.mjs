import { getAuthPolicy, isAuthMethodEnabled } from '../policy.mjs';
import { getGoogleStatus } from './google.mjs';

export async function getEnabledAuthMethods() {
    const methods = (await getAuthPolicy()).enabledAuthMethods;
    return methods.includes('google') && !(await getGoogleStatus()).available
        ? methods.filter((method) => method !== 'google') : methods;
}

export async function getDefaultAuthMethod() {
    return (await getEnabledAuthMethods())[0] || 'password';
}

export { isAuthMethodEnabled };
