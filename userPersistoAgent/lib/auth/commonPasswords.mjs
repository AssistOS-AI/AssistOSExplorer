// A small frozen list of frequently breached passwords that would otherwise
// meet the creation length rule. Shorter and single-character values are
// already refused by the length and repetition rules. Matching ignores case.
const COMMON_PASSWORDS = Object.freeze([
    '000000000000000',
    '0123456789012345',
    '1111111111222222',
    '11223344556677889900',
    '123123123123123',
    '123456123456123456',
    '123456789012345',
    '1234567890123456',
    '12345678901234567890',
    '1234567890qwertyuiop',
    '1q2w3e4r5t6y7u8i9o0p',
    '1qaz2wsx3edc4rfv',
    '1qaz2wsx3edc4rfv5tgb',
    'abc123abc123abc123',
    'abcdefghijklmnop',
    'abcdefghijklmnopqrstuvwxyz',
    'adminadminadmin',
    'administrator123',
    'administratoradministrator',
    'changemechangeme',
    'correcthorsebatterystaple',
    'iloveyouiloveyou',
    'letmeinletmeinletmein',
    'passwordpassword',
    'password12345678',
    'password123456789',
    'passwordpassword123',
    'qazwsxedcrfvtgbyhn',
    'qwerty123456789',
    'qwertyqwertyqwerty',
    'qwertyuiop123456',
    'qwertyuiopasdfgh',
    'qwertyuiopasdfghjkl',
    'qwertyuiopasdfghjklzxcvbnm',
    'trustno1trustno1',
    'welcomewelcome123',
    'zaq12wsxcde34rfv',
    'zxcvbnmasdfghjkl',
]);
const LOOKUP = new Set(COMMON_PASSWORDS);

export function isCommonPassword(normalized) {
    return LOOKUP.has(String(normalized).toLowerCase());
}
