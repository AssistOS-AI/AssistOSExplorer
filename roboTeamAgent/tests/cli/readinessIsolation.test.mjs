import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
    __testables as credentialContextTestables,
} from '../../Ploinky/Agent/lib/agentCredentialContext.mjs';
import * as providerSandboxModule from '../../Ploinky/Agent/lib/providerSandbox.mjs';
import { buildBwrapAgentCredential } from '../../Ploinky/cli/sandbox/bwrap/bwrapAgentCredential.js';
import {
    checkTaskSandboxReadiness as checkOpenCodeReadiness,
} from '../opencodeAgent/scripts/check-task-sandbox.mjs';
import {
    checkTaskSandboxReadiness as checkPiReadiness,
} from '../piAgent/scripts/check-task-sandbox.mjs';

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

const readinessImplementations = [
    {
        agent: 'OpenCode',
        provider: 'opencode',
        executable: '/home/agent/.opencode/bin/opencode',
        source: new URL('../opencodeAgent/scripts/check-task-sandbox.mjs', import.meta.url),
        shell: new URL('../opencodeAgent/readiness.sh', import.meta.url),
        run(context, injectedModule) {
            return checkOpenCodeReadiness(
                { credentialContext: context },
                { providerSandboxModule: injectedModule },
            );
        },
    },
    {
        agent: 'PI',
        provider: 'pi',
        executable: '/home/agent/.local/bin/pi',
        source: new URL('../piAgent/scripts/check-task-sandbox.mjs', import.meta.url),
        shell: new URL('../piAgent/readiness.sh', import.meta.url),
        run(context, injectedModule) {
            return checkPiReadiness({
                credentialContext: context,
                dependencies: { providerSandbox: injectedModule },
            });
        },
    },
];

for (const implementation of readinessImplementations) {
    test(`${implementation.agent} readiness uses only the canonical empty-workspace provider mode`, async () => {
        const calls = [];
        const injectedModule = {
            ...providerSandboxModule,
            spawnProviderSandbox(input, lifecycle) {
                const policy = providerSandboxModule.buildProviderSandboxPolicy(input);
                calls.push({ input, lifecycle, policy });
                return Object.freeze({
                    launch: Object.freeze({
                        mode: input.mode,
                        provider: input.provider,
                        cwd: '/workspace/readiness',
                    }),
                    completion: Promise.resolve({ code: 0, signal: null }),
                });
            },
        };

        await implementation.run(credentialContext(implementation.provider), injectedModule);

        assert.equal(calls.length, 1);
        const [{ input, policy }] = calls;
        assert.equal(input.mode, providerSandboxModule.PROVIDER_SANDBOX_MODES.READINESS);
        assert.equal(input.provider, implementation.provider);
        assert.equal(record(policy, 'WORKSPACE'), undefined);
        assert.equal(record(policy, 'WORKDIR'), undefined);
        assert.ok(record(policy, 'TMPFS', ({ target }) => target === '/workspace'));
        assert.ok(record(policy, 'DIR', ({ target }) => target === '/workspace/readiness'));
        assert.ok(record(policy, 'PROC'));
        assert.deepEqual(policy.command, [implementation.executable, '--version']);
        assert.equal(policy.env.PLOINKY_TASK_BROKER_URL, undefined);
        assert.equal(policy.env.PLOINKY_TASK_BROKER_KEY, undefined);
    });

    test(`${implementation.agent} readiness fails closed without trusted context or on provider failure`, async () => {
        const missingContextModule = {
            ...providerSandboxModule,
            spawnProviderSandbox(input) {
                providerSandboxModule.buildProviderSandboxPolicy(input);
                throw new Error('unreachable');
            },
        };
        await assert.rejects(
            implementation.run(null, missingContextModule),
            (error) => error?.code === 'PLOINKY_AGENT_CREDENTIAL_CONTEXT_REQUIRED'
                || /requires credentialContext/.test(error?.message || ''),
        );

        const failedModule = {
            ...providerSandboxModule,
            spawnProviderSandbox() {
                return Object.freeze({
                    launch: Object.freeze({ mode: 'readiness', provider: implementation.provider }),
                    completion: Promise.resolve({ code: 19, signal: null }),
                });
            },
        };
        await assert.rejects(
            implementation.run(credentialContext(implementation.provider), failedModule),
            (error) => error?.code === 'PLOINKY_PROVIDER_READINESS_FAILED',
        );
    });

    test(`${implementation.agent} readiness contains no real-workspace or direct-provider fallback`, async () => {
        const source = await fs.readFile(implementation.source, 'utf8');
        for (const forbidden of [
            'PLOINKY_WORKSPACE_ROOT',
            '/usr/bin/bwrap',
            '/root',
            'node:child_process',
            'spawnSync',
            'probeNestedBubblewrap',
            'readAgentCredentialDescriptor',
        ]) {
            assert.equal(source.includes(forbidden), false, forbidden);
        }
        assert.match(source, /import\('\/Agent\/lib\/providerSandbox\.mjs'\)/);

        const shell = await fs.readFile(implementation.shell, 'utf8');
        for (const forbidden of [
            'PLOINKY_WORKSPACE_ROOT',
            '/root',
            'check-task-sandbox',
            '--version',
        ]) {
            assert.equal(shell.includes(forbidden), false, forbidden);
        }
    });
}
