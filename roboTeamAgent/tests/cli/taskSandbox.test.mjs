import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
    __testables as credentialContextTestables,
} from '../../Ploinky/Agent/lib/agentCredentialContext.mjs';
import * as providerSandboxModule from '../../Ploinky/Agent/lib/providerSandbox.mjs';
import { buildBwrapAgentCredential } from '../../Ploinky/cli/sandbox/bwrap/bwrapAgentCredential.js';
import {
    buildTaskSandboxLaunch as buildOpenCodeLaunch,
    buildTaskSandboxPolicy as buildOpenCodePolicy,
    spawnTaskSandbox as spawnOpenCode,
} from '../opencodeAgent/scripts/task-sandbox.mjs';
import {
    buildTaskSandboxLaunch as buildPiLaunch,
    buildTaskSandboxPolicy as buildPiPolicy,
    spawnTaskSandbox as spawnPi,
} from '../piAgent/scripts/task-sandbox.mjs';

const BROKER_URL = 'http://127.0.0.1:43123/v1';
const BROKER_KEY = 'c'.repeat(43);

function credentialContext(provider) {
    const principalId = `agent:AchillesCLI/${provider}Agent`;
    const generated = buildBwrapAgentCredential({
        principalId,
        instanceId: `${provider}Agent_alias-1`,
        enableGeneration: `generation-${provider}-1`,
        runtimeKey: `${provider}Agent_alias-1`,
        routeKey: `${provider}Agent`,
        router: {
            physicalOrigin: 'http://127.0.0.1:8080',
            requestAuthority: '127.0.0.1:18080',
            host: '127.0.0.1',
            port: 8080,
        },
        admission: {
            runtimeKind: 'bwrap',
            manifestDigest: `sha256:${'1'.repeat(64)}`,
            capabilityDigest: `sha256:${'2'.repeat(64)}`,
            networkHash: `sha256:${'3'.repeat(64)}`,
        },
    }, {
        now: Math.floor(Date.now() / 1000) - 10,
        randomBytes: () => Buffer.alloc(32, 7),
        buildCredentialEnv: () => ({
            PLOINKY_AGENT_SECRET: 'a'.repeat(64),
            PLOINKY_AGENT_PRIVATE_SECRET: 'b'.repeat(64),
            PLOINKY_AGENT_API_KEY: `${principalId}|fixture-signature`,
            PLOINKY_AGENT_API_PUBLIC_KEY: Buffer.alloc(32, 8).toString('base64url'),
        }),
    });
    return credentialContextTestables.createBwrapContextFromRead({
        descriptor: generated.descriptor,
        publicAttestation: generated.publicAttestation,
    });
}

function record(policy, type, predicate = () => true) {
    return policy.records.find((candidate) => candidate.type === type && predicate(candidate));
}

const implementations = [
    {
        agent: 'OpenCode',
        provider: 'opencode',
        executable: '/home/agent/.opencode/bin/opencode',
        source: new URL('../opencodeAgent/scripts/task-sandbox.mjs', import.meta.url),
        buildPolicy: buildOpenCodePolicy,
        buildLaunch: buildOpenCodeLaunch,
        spawn: spawnOpenCode,
        dependencies(module) {
            return { providerSandboxModule: module };
        },
    },
    {
        agent: 'PI',
        provider: 'pi',
        executable: '/home/agent/.local/bin/pi',
        source: new URL('../piAgent/scripts/task-sandbox.mjs', import.meta.url),
        buildPolicy: buildPiPolicy,
        buildLaunch: buildPiLaunch,
        spawn: spawnPi,
        dependencies(module) {
            return { providerSandbox: module };
        },
    },
];

function taskInput(implementation, overrides = {}) {
    return {
        credentialContext: credentialContext(implementation.provider),
        workdir: 'projects/alpha with spaces',
        args: ['run', '--auto'],
        environment: {
            PLOINKY_TASK_BROKER_URL: BROKER_URL,
            PLOINKY_TASK_BROKER_KEY: BROKER_KEY,
        },
        ...overrides,
    };
}

for (const implementation of implementations) {
    test(`${implementation.agent} delegates exact policy and launch to the canonical helper`, async () => {
        const input = taskInput(implementation);
        const dependencies = implementation.dependencies(providerSandboxModule);
        const policy = await implementation.buildPolicy(input, dependencies);
        const launch = await implementation.buildLaunch(input, dependencies);

        assert.equal(policy.mode, providerSandboxModule.PROVIDER_SANDBOX_MODES.TASK);
        assert.equal(policy.provider, implementation.provider);
        assert.equal(policy.workdir, input.workdir);
        assert.deepEqual(policy.command, [implementation.executable, ...input.args]);
        assert.deepEqual(record(policy, 'WORKSPACE'), { type: 'WORKSPACE', mode: 'ro' });
        assert.deepEqual(record(policy, 'WORKDIR'), { type: 'WORKDIR', path: input.workdir });
        assert.ok(record(policy, 'TMPFS', ({ target }) => target === '/workspace/.ploinky'));
        assert.ok(record(policy, 'TMPFS', ({ target }) => target === '/workspace/.data'));
        assert.ok(record(policy, 'HOME'));
        assert.ok(record(policy, 'RO_PATH', ({ target }) => target === implementation.executable));
        assert.ok(record(policy, 'PROC'));
        assert.equal(policy.env.HOME, '/home/agent');
        assert.equal(policy.env.PLOINKY_TASK_BROKER_URL, BROKER_URL);
        assert.equal(policy.env.PLOINKY_TASK_BROKER_KEY, BROKER_KEY);
        assert.equal(JSON.stringify(policy).includes('/root'), false);

        assert.equal(launch.helper, providerSandboxModule.PROVIDER_SANDBOX_HELPER);
        assert.deepEqual(launch.args, []);
        assert.ok(Buffer.isBuffer(launch.descriptor));
        assert.equal(launch.descriptor.subarray(0, 8).toString('ascii'), 'PLBWLP01');
        assert.equal(launch.command[0], implementation.executable);
    });

    test(`${implementation.agent} rejects legacy overrides, root workdirs, and raw credentials`, async () => {
        const dependencies = implementation.dependencies(providerSandboxModule);
        for (const [field, value] of [
            ['createProjectDir', true],
            ['command', ['/tmp/provider']],
            ['projectDir', '/workspace/projects/alpha'],
            ['readOnlyPaths', ['/tmp']],
            ['writablePaths', ['/workspace']],
        ]) {
            await assert.rejects(
                implementation.buildPolicy(taskInput(implementation, { [field]: value }), dependencies),
                /unknown field|unsupported field/,
            );
        }
        for (const workdir of ['/workspace', '', '.', '.data', '.ploinky']) {
            await assert.rejects(
                implementation.buildPolicy(taskInput(implementation, { workdir }), dependencies),
                (error) => error?.code === 'PLOINKY_WORKDIR_ROOT_FORBIDDEN'
                    || error?.code === 'PLOINKY_WORKDIR_INVALID',
            );
        }
        await assert.rejects(
            implementation.buildPolicy(taskInput(implementation, {
                environment: {
                    PLOINKY_TASK_BROKER_URL: BROKER_URL,
                    PLOINKY_TASK_BROKER_KEY: BROKER_KEY,
                    OPENAI_API_KEY: 'forbidden-direct-credential',
                },
            }), dependencies),
            (error) => error?.code === 'PLOINKY_PROVIDER_ENV_INVALID',
        );
    });

    test(`${implementation.agent} spawn adapter preserves lifecycle and fixed provider identity`, async () => {
        const calls = [];
        const expected = Object.freeze({
            child: Object.freeze({}),
            completion: Promise.resolve({ code: 0, signal: null }),
        });
        const injectedModule = {
            ...providerSandboxModule,
            spawnProviderSandbox(input, lifecycle) {
                calls.push({ input, lifecycle });
                return expected;
            },
        };
        const lifecycle = Object.freeze({
            activateCapability() {},
            deactivateCapability() {},
            leaseMetadata: Object.freeze({ taskId: `${implementation.provider}-task-1` }),
        });

        const result = await implementation.spawn(
            taskInput(implementation),
            lifecycle,
            implementation.dependencies(injectedModule),
        );

        assert.equal(result, expected);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].input.mode, providerSandboxModule.PROVIDER_SANDBOX_MODES.TASK);
        assert.equal(calls[0].input.provider, implementation.provider);
        assert.equal(calls[0].input.command[0], implementation.executable);
        assert.equal(calls[0].lifecycle, lifecycle);
    });

    test(`${implementation.agent} adapter contains no local bwrap, path, or credential fallback`, async () => {
        const source = await fs.readFile(implementation.source, 'utf8');
        assert.match(source, /import\('\/Agent\/lib\/providerSandbox\.mjs'\)/);
        for (const forbidden of [
            '/usr/bin/bwrap',
            '/root',
            'PLOINKY_WORKSPACE_ROOT',
            'probeNestedBubblewrap',
            'prepareTaskSandbox',
            'process.env',
            'node:child_process',
            'realpath',
            'mkdir',
        ]) {
            assert.equal(source.includes(forbidden), false, forbidden);
        }
    });
}
