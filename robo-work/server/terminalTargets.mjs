import { exactObject, fail } from './stateProtocol.mjs';
import { contextForTerminalTargets, verifyProviderTerminalTargetsRequest } from './coordinatorAuth.mjs';
import { parseJsonBody, withDurableReplay } from './taskReferenceAdapter.mjs';

// Terminal-target inventory (interface note 2.3 (9), "Terminal-target inventory"; plan §10.1;
// S6 source-only subset, Part E). `POST <terminals.path>/targets` on the provider port returns
// the robots an administrator may open a robot terminal on:
// `{version: 1, targets: [{targetId, label}]}`.
//
// Authorization: the Router Request verified by `verifyProviderTerminalTargetsRequest` (a
// direct non-guest user with the role `admin`). Its token ID is consumed durably (the S1
// `token_replay` table) once the request has passed verification, also when the request is
// then refused, so a replay is refused across a verifier or provider restart. That key is the
// only write: discovery creates no ownership session, PTY, execution, preparation or grant.
//
// Content: every workspace robot that S1 reports `ready` (attested in the current generation,
// not preparing, not quarantined; so never deleted, deleting, provisioning or failed). The
// label is the robot name when it is 1-128 UTF-8 bytes with no control character (Cc: C0, DEL,
// C1), otherwise the robot ID. More than 256 targets, or a response over 64 KiB, refuses the
// whole request with 503 `target_inventory_too_large`; the list is never truncated.

export const TERMINAL_TARGETS_VERSION = 1;
export const MAX_TARGETS = 256;
export const MAX_INVENTORY_BYTES = 64 * 1024;
const LABEL_MAX_BYTES = 128;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const SELECTION = /^[A-Za-z0-9_.:-]{1,128}$/;

// The refusal of an inventory that would exceed a bound. providerHttp maps it to 503 with the
// body `{error: 'target_inventory_too_large'}` and nothing else.
export class TargetInventoryError extends Error {
    constructor() {
        super('The terminal-target inventory exceeds its bounds.');
        this.name = 'TargetInventoryError';
        this.code = 'target_inventory_too_large';
    }
}

export function labelFor(robot) {
    const name = robot.name;
    if (typeof name === 'string' && !CONTROL.test(name)) {
        const bytes = Buffer.byteLength(name, 'utf8');
        if (bytes >= 1 && bytes <= LABEL_MAX_BYTES) return name;
    }
    return robot.robotId;
}

// Projects S1 robot views (`listRobots`) to the inventory result and applies both bounds. The
// byte bound is measured on the exact JSON the handler sends.
export function projectTargets(robots) {
    const targets = robots.filter((robot) => robot.ready === true).map((robot) => ({ targetId: robot.robotId, label: labelFor(robot) }));
    if (targets.length > MAX_TARGETS) throw new TargetInventoryError();
    const result = { version: TERMINAL_TARGETS_VERSION, targets };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_INVENTORY_BYTES) throw new TargetInventoryError();
    return result;
}

// A relative path: 1-4096 characters, no leading `/`, no `..` segment, no control character.
function isRelativePath(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= 4096 && !value.startsWith('/')
        && !value.split('/').includes('..') && !CONTROL.test(value);
}

// The request body is exactly `{project: null | {selection, relativePath}}`, checked for
// syntax only: the project scopes nothing in this subset.
export function validateTargetsBody(body) {
    exactObject(body, ['project']);
    if (body.project === null) return body;
    exactObject(body.project, ['selection', 'relativePath']);
    if (typeof body.project.selection !== 'string' || !SELECTION.test(body.project.selection)) fail('invalid_request');
    if (!isRelativePath(body.project.relativePath)) fail('invalid_request');
    return body;
}

function canonicalBasePath(value) {
    return typeof value === 'string' && /^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(value)
        && !value.split('/').some((segment) => segment === '.' || segment === '..');
}

// `store`: an open S1 worker state with the S1x extension limits (the replay key needs
// `tokenReplayEntries`; without it the request fails closed with capacity_exceeded).
// `basePath`: the declared `terminals.path`. `verifier`: from `createVerifierConfig`.
export function createTerminalTargetsAdapter({ store, workspaceId, verifier, basePath }) {
    for (const method of ['listRobots', 'consumeTokenIds']) {
        if (!store || typeof store[method] !== 'function') fail('invalid_request');
    }
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) fail('invalid_request');
    if (!canonicalBasePath(basePath)) fail('invalid_request');
    const targetsPath = `${basePath}/targets`;

    return Object.freeze({
        // POST <basePath>/targets with exactly {project}, no query.
        targets(request) {
            const facts = verifyProviderTerminalTargetsRequest(verifier, request);
            return withDurableReplay(store, [facts], (replay) => {
                // Consumed first, so a replayed token is refused whatever its route or body.
                store.consumeTokenIds(replay);
                if (facts.method !== 'POST' || facts.path !== targetsPath || facts.query !== '') fail('invalid_request');
                validateTargetsBody(parseJsonBody(request.body));
                return projectTargets(store.listRobots(contextForTerminalTargets(workspaceId, facts)));
            });
        }
    });
}
