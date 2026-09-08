import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createTaskControlCommands,
    normalizeLoginCatalog,
    normalizeLoginChallenge,
} from '../src/lib/taskControlCommands.mjs';
import { createWebchatInteractionController } from '../src/lib/webchatInteractionController.mjs';

const TASK_ID = 'task_111111111111111111111111';

test('/task model returns the agent endpoint catalog without creating an interaction', async () => {
    const calls = [];
    const interactions = {
        async select(request) {
            throw new Error(`unexpected select: ${request.title}`);
        },
        async input() { throw new Error('unexpected input'); },
    };
    const control = async (input) => {
        calls.push(['control', input]);
        if (input.operation === 'list_models') {
            return { type: 'task-model-catalog', models: [{ key: 'openai/gpt-test', label: 'GPT Test' }] };
        }
        return { model: { key: input.modelKey, label: 'GPT Test' } };
    };
    const commands = createTaskControlCommands({
        workingDir: '/work',
        interactions,
        controlTaskSessionImpl: control,
    });

    const result = await commands.model(TASK_ID, '', { context: { sourceTabId: 'tab_model' } });
    assert.equal(result.type, 'task-model-catalog');
    assert.equal(result.models[0].key, 'openai/gpt-test');
    assert.deepEqual(calls.filter(([kind]) => kind === 'control').map(([, input]) => input.operation), [
        'list_models',
    ]);
    assert.equal(calls.some(([kind]) => kind === 'select'), false);
});

test('/task model validates the catalog and persists an explicit model key', async () => {
    const operations = [];
    const commands = createTaskControlCommands({
        workingDir: '/work',
        interactions: {
            async select() { throw new Error('unexpected select'); },
            async input() { throw new Error('unexpected input'); },
        },
        controlTaskSessionImpl: async (input) => {
            operations.push(input.operation);
            if (input.operation === 'list_models') {
                return { type: 'task-model-catalog', models: [{ key: 'openai/gpt-test', label: 'GPT Test' }] };
            }
            return { model: { key: input.modelKey, label: 'GPT Test' } };
        },
    });

    const result = await commands.model(TASK_ID, 'openai/gpt-test');
    assert.equal(result.model.key, 'openai/gpt-test');
    assert.deepEqual(operations, ['list_models', 'set_model']);
});

test('/task login owns provider and secret prompting in AchillesCLI', async () => {
    const calls = [];
    const interactions = {
        async select(request) {
            calls.push(['select', request.title]);
            if (request.title === 'Connect provider') return 'openai';
            return 'api_key';
        },
        async input(request) {
            calls.push(['input', request.type]);
            assert.equal(request.targetTaskId, TASK_ID);
            assert.equal(request.targetTabId, 'tab_login');
            assert.equal(request.targetPageInstanceId, 'page_login');
            return 'secret-value';
        },
    };
    const control = async (input) => {
        calls.push(['control', input]);
        if (input.operation === 'login_describe') {
            return {
                providers: [{
                    key: 'openai',
                    label: 'OpenAI',
                    methods: [{ key: 'api_key', kind: 'api_key', label: 'API key', secret: true }],
                }],
            };
        }
        return { status: 'completed', provider: input.provider };
    };
    const commands = createTaskControlCommands({
        workingDir: '/work',
        interactions,
        controlTaskSessionImpl: control,
    });

    const result = await commands.login(TASK_ID, '', '', {
        context: { sourceTabId: 'tab_login', sourcePageInstanceId: 'page_login' },
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(calls.filter(([kind]) => kind === 'input'), [['input', 'secret']]);
    const start = calls.find(([kind, input]) => kind === 'control' && input.operation === 'login_start')[1];
    assert.equal(start.apiKey, 'secret-value');
});

test('/task login renders a structured device-code challenge in the originating task tab', async () => {
    const requests = [];
    const calls = [];
    const completed = [];
    let challengeAborted = false;
    const interactions = {
        async select(request, { signal } = {}) {
            requests.push(request);
            if (request.title === 'Connect provider') return 'openai';
            if (request.title === 'Connect OpenAI') return 'device_code';
            return new Promise((resolve, reject) => {
                signal?.addEventListener('abort', () => {
                    challengeAborted = true;
                    reject(new Error('interaction_cancelled'));
                }, { once: true });
            });
        },
        async input() { throw new Error('unexpected input'); },
    };
    const control = async (input) => {
        calls.push(input);
        if (input.operation === 'login_describe') {
            return {
                providers: [{
                    key: 'openai',
                    label: 'OpenAI',
                    methods: [{ key: 'device_code', kind: 'device_code', label: 'Device code' }],
                }],
            };
        }
        if (input.operation === 'login_start') {
            return {
                status: 'running',
                flowId: 'flow_123',
                challenge: {
                    type: 'device_code',
                    verificationUri: 'https://example.com/device',
                    userCode: 'ABCD-EFGH',
                    expiresInSeconds: 900,
                },
            };
        }
        return { status: 'completed', flowId: 'flow_123', provider: 'openai' };
    };
    const commands = createTaskControlCommands({
        workingDir: '/work',
        interactions,
        controlTaskSessionImpl: control,
        onLoginCompleted: (taskId, flow) => completed.push({ taskId, flow }),
        pollIntervalMs: 1,
    });

    const result = await commands.login(TASK_ID, '', '', {
        context: { sourceTabId: 'tab_login', sourcePageInstanceId: 'page_login' },
    });
    assert.equal(result.status, 'completed');
    const challenge = requests.find((request) => request.title === 'Complete provider authentication');
    assert.deepEqual(challenge.challenge, {
        type: 'device_code',
        verificationUri: 'https://example.com/device',
        userCode: 'ABCD-EFGH',
        expiresInSeconds: 900,
    });
    assert.equal(challenge.targetTaskId, TASK_ID);
    assert.equal(challenge.targetTabId, 'tab_login');
    assert.equal(challenge.targetPageInstanceId, 'page_login');
    assert.deepEqual(challenge.options, [
        { value: 'cancel', label: 'Cancel', tone: 'danger' },
    ]);
    assert.match(challenge.message, /closes automatically/i);
    assert.equal(challengeAborted, true);
    assert.deepEqual(calls.map((entry) => entry.operation), [
        'login_describe', 'login_start', 'login_status',
    ]);
    assert.deepEqual(completed, [{
        taskId: TASK_ID,
        flow: { status: 'completed', flowId: 'flow_123', provider: 'openai' },
    }]);
});

test('aborting a task interaction emits the resolution that closes its WebChat menu', async () => {
    const writes = [];
    const abortController = new AbortController();
    const controller = createWebchatInteractionController({
        stdout: { write: (value) => writes.push(JSON.parse(value)) },
        timeoutMs: 1000,
    });
    const pending = controller.select({
        title: 'Complete provider authentication',
        options: [{ value: 'cancel', label: 'Cancel' }],
        targetTaskId: TASK_ID,
        targetTabId: 'tab_login',
    }, { signal: abortController.signal });
    const request = writes[0];

    abortController.abort();
    await assert.rejects(pending, /interaction_cancelled/);
    assert.equal(writes[1].__webchatInteractionResolved, 1);
    assert.equal(writes[1].id, request.id);
    assert.equal(writes[1].status, 'cancelled');
    controller.dispose();
});

test('browser cancellation rejects the pending task interaction', async () => {
    const writes = [];
    const controller = createWebchatInteractionController({
        stdout: { write: (value) => writes.push(JSON.parse(value)) },
        timeoutMs: 1000,
    });
    const pending = controller.input({
        title: 'Enter API key',
        targetTaskId: TASK_ID,
        targetTabId: 'tab_login',
        targetPageInstanceId: 'page_login',
    });
    const request = writes[0];

    assert.equal(controller.cancel(request.id), true);
    await assert.rejects(pending, /interaction_cancelled/);
    assert.equal(writes[1].status, 'cancelled');
    assert.equal(controller.cancel(request.id), false);
});

test('cancelling a browser interaction also cancels an active provider flow', async () => {
    const operations = [];
    const commands = createTaskControlCommands({
        workingDir: '/work',
        interactions: {
            async select(request) {
                assert.equal(request.targetPageInstanceId, 'page_login');
                throw new Error('interaction_cancelled');
            },
            async input() { throw new Error('unexpected input'); },
        },
        controlTaskSessionImpl: async (input) => {
            operations.push(input.operation);
            if (input.operation === 'login_describe') {
                return {
                    providers: [{
                        key: 'openai',
                        methods: [{ key: 'device', kind: 'device_code', label: 'Device code' }],
                    }],
                };
            }
            if (input.operation === 'login_start') {
                return {
                    status: 'running',
                    flowId: 'flow_refresh',
                    challenge: {
                        type: 'device_code',
                        verificationUri: 'https://example.com/device',
                        userCode: 'ABCD-EFGH',
                    },
                };
            }
            if (input.operation === 'login_cancel') {
                return { status: 'cancelled', flowId: input.flowId };
            }
            throw new Error(`unexpected operation: ${input.operation}`);
        },
        pollIntervalMs: 1,
    });

    await assert.rejects(commands.login(TASK_ID, 'openai', 'device', {
        context: { sourceTabId: 'tab_login', sourcePageInstanceId: 'page_login' },
    }), /interaction_cancelled/);
    assert.deepEqual(operations, ['login_describe', 'login_start', 'login_cancel']);
});

test('AchillesCLI drops unknown login methods and rejects local callback challenges', () => {
    assert.deepEqual(normalizeLoginCatalog({
        providers: [{
            key: 'openai',
            methods: [
                { key: 'device', kind: 'device_code', label: 'Device code' },
                { key: 'browser', kind: 'local_callback', label: 'Browser callback' },
            ],
        }],
    })[0].methods.map((method) => method.key), ['device']);
    assert.throws(() => normalizeLoginChallenge({
        type: 'auth_url',
        url: 'http://localhost:1455/auth/callback',
    }), /unsupported_container_login_challenge/);
    assert.throws(() => normalizeLoginChallenge({
        type: 'manual_oauth_code',
        url: 'https://localhost:1455/auth/callback',
    }), /unsupported_container_login_challenge/);
});

test('generic interaction controller maps opaque option ids back to Achilles values', async () => {
    const writes = [];
    const controller = createWebchatInteractionController({
        stdout: { write: (value) => writes.push(JSON.parse(value)) },
        timeoutMs: 1000,
    });
    const pending = controller.select({
        title: 'Choose model',
        options: [{ value: 'openai/gpt-test', label: 'GPT Test' }],
        searchable: true,
        targetTaskId: TASK_ID,
        targetTabId: 'tab_model',
    });
    const request = writes[0];
    assert.equal(request.kind, 'select');
    assert.equal(request.options[0].id, 'choice_0');
    assert.equal(request.options[0].value, undefined);
    assert.equal(request.targetTaskId, TASK_ID);
    assert.equal(request.targetTabId, 'tab_model');
    assert.equal(controller.resolve({ id: request.id, optionId: 'choice_0' }), true);
    assert.equal(await pending, 'openai/gpt-test');
    controller.dispose();
});
