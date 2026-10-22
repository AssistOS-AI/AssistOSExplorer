import { EMAIL_IMPORT_LIMIT, normalizeEmailAddress } from './robot-email.mjs';

function httpError(statusCode, message) {
    return Object.assign(new Error(message), { statusCode });
}

// Creates one robot per email address, named exactly by the address. An address that already names
// a robot, compared without case, is reported and left alone, so importing the same file twice
// creates nothing new.
export async function importEmailRobots(robotStore, addresses, { codingAgents } = {}) {
    if (!Array.isArray(addresses) || addresses.length === 0) throw httpError(400, 'addresses must be a non-empty list');
    if (addresses.length > EMAIL_IMPORT_LIMIT) throw httpError(400, `at most ${EMAIL_IMPORT_LIMIT} addresses can be imported at once`);
    const taken = new Set((await robotStore.list()).map(robot => robot.name.toLowerCase()));
    const result = { created: [], existing: 0, invalid: [] };
    for (const value of addresses) {
        const address = normalizeEmailAddress(value);
        if (!address) { if (result.invalid.length < 20) result.invalid.push(String(value ?? '').slice(0, 80)); continue; }
        if (taken.has(address.toLowerCase())) { result.existing += 1; continue; }
        taken.add(address.toLowerCase());
        result.created.push(await robotStore.create({ name: address, codingAgents }));
    }
    return result;
}
