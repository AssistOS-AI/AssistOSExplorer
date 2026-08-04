import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
    checkTaskSandboxReadiness as checkOpenCodeReadiness,
} from '../opencodeAgent/scripts/check-task-sandbox.mjs';
import {
    __testables as openCodeSandboxTestables,
} from '../opencodeAgent/scripts/task-sandbox.mjs';
import {
    checkTaskSandboxReadiness as checkPiReadiness,
} from '../piAgent/scripts/check-task-sandbox.mjs';
import {
    __testables as piSandboxTestables,
} from '../piAgent/scripts/task-sandbox.mjs';

const readinessImplementations = [
    {
        agent: 'OpenCode',
        checkReadiness: checkOpenCodeReadiness,
        sandboxTestables: openCodeSandboxTestables,
        source: new URL('../opencodeAgent/scripts/check-task-sandbox.mjs', import.meta.url),
    },
    {
        agent: 'PI',
        checkReadiness: checkPiReadiness,
        sandboxTestables: piSandboxTestables,
        source: new URL('../piAgent/scripts/check-task-sandbox.mjs', import.meta.url),
    },
];

for (const {
    agent,
    checkReadiness,
    sandboxTestables,
    source,
} of readinessImplementations) {
    test(`${agent} readiness is capability-only and cannot mount the real workspace`, async () => {
        const capability = Object.freeze({ procMode: 'private' });
        let probeCalls = 0;
        const result = checkReadiness({
            probeNestedBubblewrapImpl(...args) {
                probeCalls += 1;
                assert.deepEqual(args, []);
                return capability;
            },
        });

        assert.equal(result, capability);
        assert.equal(probeCalls, 1);

        const readinessSource = await fs.readFile(source, 'utf8');
        for (const forbidden of [
            'PLOINKY_WORKSPACE_ROOT',
            'buildTaskSandboxLaunch',
            'spawnSync',
            '--version',
        ]) {
            assert.equal(readinessSource.includes(forbidden), false, forbidden);
        }

        for (const procMode of ['private', 'inherited']) {
            const probeArgs = sandboxTestables.minimalProbeArgs(procMode, 4242);
            assert.equal(probeArgs.includes('--bind'), false);
            assert.equal(probeArgs.includes('--chdir'), false);
            assert.equal(probeArgs.includes('--clearenv'), false);
        }
    });
}
