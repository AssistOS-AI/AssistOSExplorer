import { getAuthPolicy } from '../policy.mjs';
import { getInstallationSetup } from '../setup.mjs';
import { getGoogleStatus } from './google.mjs';
import { PASSWORD_POLICY } from './userPassword.mjs';

// Public, secret-free presentation state shared by both protocol adapters. It
// is advisory: every operation is authorized again by the server. Email signup
// needs open registration, the password method and email delivery for the
// verification code; it does not require the email-code sign-in method.
export async function wizardConfiguration({ emailAvailable = false } = {}) {
    const setup = await getInstallationSetup();
    const policy = await getAuthPolicy();
    const enabled = policy.enabledAuthMethods;
    const google = (await getGoogleStatus()).available;
    const registrationOpen = !setup.complete || policy.selfRegistrationEnabled;
    const signup = {
        email: registrationOpen && enabled.includes('password') && emailAvailable,
        google: registrationOpen && google,
    };
    return {
        setupComplete: setup.complete,
        registration: signup.email || signup.google,
        signup,
        methods: {
            password: enabled.includes('password'),
            emailCode: emailAvailable && enabled.includes('emailCode'),
            passkey: enabled.includes('passkey'),
            totp: enabled.includes('totp'),
            google,
        },
        passwordPolicy: {
            minLength: PASSWORD_POLICY.minLength,
            maxLength: PASSWORD_POLICY.maxLength,
            maxRawLength: PASSWORD_POLICY.maxRawLength,
            normalization: PASSWORD_POLICY.normalization,
        },
    };
}
