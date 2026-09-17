// The My Account operations a single-use re-authentication grant can authorize.
// Grant issuance and Google re-authentication transactions share this one set,
// so every confirmation method accepts exactly the same operations.
export const GRANT_OPERATIONS = new Set(['passkey.register', 'totp.enroll', 'contact.verify', 'password.set']);
