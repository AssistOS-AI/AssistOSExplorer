import { getAuthPolicy } from '../policy.mjs';
import { getInstallationSetup } from '../setup.mjs';
import { getGoogleStatus } from './google.mjs';
import { PASSWORD_POLICY } from './userPassword.mjs';

// Public, secret-free presentation state shared by both protocol adapters. It
// is advisory: every operation is authorized again by the server. Email signup
// needs open registration and the password method; the verification code is
// only required while the policy asks for it and delivery is available. The
// reset offer follows the same delivery-and-password rule.
export async function wizardConfiguration({ emailAvailable = false } = {}) {
    const setup = await getInstallationSetup();
    const policy = await getAuthPolicy();
    const enabled = policy.enabledAuthMethods;
    const google = (await getGoogleStatus()).available;
    const registrationOpen = !setup.complete || policy.selfRegistrationEnabled;
    const verification = policy.signupEmailVerificationRequired ? 'required' : 'none';
    const passwordEnabled = enabled.includes('password');
    const signup = {
        email: registrationOpen && passwordEnabled && (verification !== 'required' || emailAvailable),
        verification,
        google: registrationOpen && google,
    };
    return {
        setupComplete: setup.complete,
        initialPasswordSetup: !setup.complete && passwordEnabled,
        registration: (!setup.complete && passwordEnabled) || signup.email || signup.google,
        signup,
        passwordReset: passwordEnabled && emailAvailable,
        methods: {
            password: passwordEnabled,
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
