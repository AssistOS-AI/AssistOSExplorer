import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { rawWireCaseNames } from './helpers/alaSuite.mjs';
import { runEndpointTopology } from './helpers/endpointTopology.mjs';
import { createAdmission } from '../../server/execution/supervisorRequestValidator.mjs';

// ALA's raw-wire conformance suite (tests/provider-conformance.mjs, read from the ALA checkout) against the REAL
// provider endpoint, started by the non-Node parent. fd 4 is served by the real supervisor validator with a
// deterministic fake keeper, so the twelve refusals and the positive control are decided by production validation.
const runner = fileURLToPath(new URL('./fixtures/alaRawRunner.mjs', import.meta.url));
const names = await rawWireCaseNames();

test('the raw-wire suite exposes the cases this endpoint must pass (twelve refusals, handle, unknown type, positive control)', () => {
    assert.equal(names.length, 15);
    assert.ok(names.some((name) => name.includes('a valid crafted start is admitted')));
});

for (const name of names) {
    test(`raw-wire conformance against the endpoint: ${name}`, async () => {
        const run = await runEndpointTopology({ alaScript: runner, alaArgs: [name], waitFor: ['ala', 'endpoint'] });
        assert.ok(run.ala, `the runner produced no result (stderr: ${run.stderr})`);
        assert.equal(run.ala.found, true, 'the suite case exists');
        assert.equal(run.ala.ok, true, run.ala.error ?? 'the case failed');
        assert.equal(run.exits.ala?.code, 0);
        // The endpoint never crashed: it ended quietly, or on the failure that this case provokes.
        assert.ok([0, 70].includes(run.exits.endpoint?.code), `endpoint exit ${JSON.stringify(run.exits.endpoint)}`);
    });
}

// Negative controls for the suite itself: a supervisor validator that admits what it must refuse makes the very same
// raw-wire cases fail, so the passes above are decided by the validator and not by a blanket refusal or a blanket yes.
const permissive = (streamDirectory) => createAdmission({
    grants: [{ path: '/projects/g', access: 'write' }, { path: '/projects/ro', access: 'write' }, { path: '/outside', access: 'write' }],
    inventory: [{ name: 'codex' }, { name: 'claude' }], streamDirectory, tempRoots: ['/tmp', '/outside']
});
for (const fragment of ['a folder outside the admitted grants', 'a write folder wider than a read-only grant', 'a working directory outside the admitted view']) {
    test(`negative control: with a validator that admits it, the suite fails "${fragment}"`, async () => {
        const name = names.find((candidate) => candidate.includes(fragment));
        const run = await runEndpointTopology({ alaScript: runner, alaArgs: [name], admission: permissive });
        assert.equal(run.ala.found, true);
        assert.equal(run.ala.ok, false, 'the case must fail when the server admits the crafted request');
        assert.match(run.ala.error, /answered started|never starts|received|expected|false/u);
        assert.equal(run.keeper.log.starts.length, 1, 'the permissive validator really started the process');
    });
}
