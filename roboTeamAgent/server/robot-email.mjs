// A robot whose name is an email address owns that mailbox: the Robots tab's CSV import creates one
// robot per address, named exactly by it. Robots cannot be renamed, so the address never changes.

// Deliberately plain: one local part, one dotted domain, no spaces, quotes or angle brackets, so an
// address can be placed in a robot's instructions as-is.
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u;
// Robot names are at most 80 characters, so longer addresses cannot name a robot.
const MAX_ADDRESS = 80;
export const EMAIL_IMPORT_LIMIT = 200;

export function normalizeEmailAddress(value) {
    const address = String(value ?? '').trim();
    return address.length <= MAX_ADDRESS && ADDRESS.test(address) ? address : null;
}

export function robotEmailAddress(robot) {
    return normalizeEmailAddress(robot?.name);
}

// The identity a robot receives with its address. The mailbox is signed in by a person in the
// robot's Chromium; RoboTeam never stores or hands out its password.
export function emailInstructions(address) {
    return [
        `You are the robot ${address}, and this is your own email address. Use it when your work needs an email address, and read or send mail through its webmail in Chromium, where a person signs the mailbox in for you. You never receive its password.`,
        'Do not sign in, recover, verify, reset or change the password or security settings of this mailbox.',
        'If the mailbox is signed out or asks for a password, a code or another verification, stop and ask a person to sign it in.',
    ].join(' ');
}
