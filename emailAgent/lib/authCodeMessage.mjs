// Content for `email_send_auth_code`. A signup verification code says that no
// account exists until the code is entered; every other code keeps the generic
// wording. A configured template receives the purpose so it can branch.
export const AUTH_CODE_PURPOSES = Object.freeze(['signup-verification']);

export function authCodeMessage({ code, purpose }) {
    if (purpose === undefined || purpose === '') {
        return { subject: 'Your authentication code', text: `Your authentication code is: ${code}`, variables: { code } };
    }
    if (purpose !== 'signup-verification') throw new Error('Unsupported authentication code purpose.');
    return {
        subject: 'Verify your email to finish creating your account',
        text: `Use this code to verify your email address: ${code}. Your account is created only after you enter this code on the sign-up page. `
            + 'If you did not start a sign-up, ignore this message. Never share this code.',
        variables: { code, purpose },
    };
}
