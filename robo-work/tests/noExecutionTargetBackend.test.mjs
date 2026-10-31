// r10 Q1 = A preservation guard: the existing-agent Environment backend is not part of this version. Existing-agent
// environments are refused in admission validation (stateProtocol.refuseEnvironmentSelection); no module under server/
// may import an executionTarget library, a helper-ticket client or the helper's qualification or journal modules.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');
// Assembled so this file never spells a whole forbidden name.
const FORBIDDEN = [['execution', 'Target'], ['helper', 'Ticket'], ['target-helper', '-ticket'], ['qualification', 'Store'], ['journal', 'Model']].map((parts) => parts.join(''));

function* sources(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) yield* sources(full);
        else if (entry.isFile() && /\.(mjs|js|json|sh)$/.test(entry.name)) yield full;
    }
}

test('r10 Q1 = A: no executionTarget, helper-ticket, qualification-store or journal-model name remains under robo-work/server', () => {
    assert.equal(fs.existsSync(path.join(SERVER, 'executionTarget')), false);
    const offenders = [];
    let scanned = 0;
    for (const file of sources(SERVER)) {
        scanned += 1;
        const text = fs.readFileSync(file, 'utf8');
        for (const name of FORBIDDEN) if (text.includes(name)) offenders.push(`${path.relative(SERVER, file)}: ${name}`);
    }
    assert.ok(scanned > 40, 'the scan covered the server tree');
    assert.deepEqual(offenders, []);
});
