// Presence is intentional: PROD='', PROD='false' and PROD='0' all select
// Google-only authentication. An absent variable retains local sign-in.
export function googleOnlyAuthentication() {
    return process.env.PROD !== undefined;
}

export function assertLocalAuthenticationAllowed() {
    if (googleOnlyAuthentication()) {
        throw Object.assign(new Error('This sign-in method is not available.'), {
            code: 'auth_method_disabled',
            statusCode: 404,
        });
    }
}
