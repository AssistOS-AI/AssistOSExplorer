import { getAuthPolicy } from '../policy.mjs';
import { getInstallationSetup } from '../setup.mjs';
import { getGoogleStatus } from './google.mjs';
import { isAdministratorPasswordConfigured } from './adminPassword.mjs';

// Public, secret-free presentation state shared by both protocol adapters.
export async function wizardConfiguration({ emailAvailable = false } = {}) {
    const setup = await getInstallationSetup();
    const policy = await getAuthPolicy();
    const enabled = policy.enabledAuthMethods;
    const google = (await getGoogleStatus()).available;
    const registrationOpen = !setup.complete || policy.selfRegistrationEnabled;
    return {
        setupComplete: setup.complete,
        registration: registrationOpen && ((emailAvailable && enabled.includes('emailCode')) || google),
        methods: {
            emailCode: emailAvailable && enabled.includes('emailCode'),
            passkey: enabled.includes('passkey'),
            totp: enabled.includes('totp'),
            google,
        },
        adminPassword: isAdministratorPasswordConfigured(),
    };
}
