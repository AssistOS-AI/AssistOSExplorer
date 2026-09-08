import test from 'node:test';
import assert from 'node:assert/strict';

import { createNativeInteractions } from '../src/lib/nativeInteractions.mjs';
import { createWebchatInteractionController } from '../src/lib/webchatInteractionController.mjs';
import { parseWebchatInteractionResponse } from '../src/permissions/protocol.mjs';

const nativeEvent = (id) => ({
    type: 'coding-agent-request', id, kind: 'permission',
    title: 'Native request', message: 'Approve requested paths', detail: { filesystem: ['/workspace/file'] },
    options: [
        { id: 'native/deny', label: 'Reject' },
        { id: 'native/session', label: 'Grant session scope', description: 'Only requested paths' },
    ],
});

function setup(t) {
    const writes = [];
    const webchat = createWebchatInteractionController({ stdout: { write: (text) => writes.push(JSON.parse(text)) } });
    const native = createNativeInteractions({ webchatController: webchat });
    t.after(() => { native.dispose(); webchat.dispose(); });
    return { writes, webchat, native };
}

const context = { sourceTabId: 'tab_one', sourcePageInstanceId: 'page_one' };
const otherContext = { sourceTabId: 'tab_one', sourcePageInstanceId: 'page_two' };

test('native permissions queue with model/login interactions but distinct pages remain simultaneous', async (t) => {
    const { writes, webchat, native } = setup(t);
    const login = webchat.input({
        title: 'Authenticate', type: 'secret', targetTabId: context.sourceTabId,
        targetPageInstanceId: context.sourcePageInstanceId,
    });
    const permission = native.request(nativeEvent('native-one'), { context, turnId: 'turn-one' });
    const model = webchat.select({
        title: 'Model', options: [{ label: 'Model A', value: 'provider/model' }],
        targetTabId: context.sourceTabId, targetPageInstanceId: context.sourcePageInstanceId,
    });
    const elsewhere = native.request(nativeEvent('native-two'), { context: otherContext, turnId: 'turn-two' });
    const menus = () => writes.filter((entry) => entry.__webchatInteraction);
    assert.deepEqual(menus().map((entry) => entry.title), ['Authenticate', 'Native request']);
    assert.equal(webchat.resolve({ id: menus()[0].id, response: 'secret' }, otherContext), false);
    assert.equal(webchat.resolve({ id: menus()[1].id, optionId: 'choice_1' }, otherContext), true);
    assert.equal(await elsewhere, 'native/session');
    assert.equal(webchat.resolve({ id: menus()[0].id, response: 'secret' }, context), true);
    assert.equal(await login, 'secret');
    const permissionMenu = menus()[2];
    assert.equal(permissionMenu.targetTabId, context.sourceTabId);
    assert.equal(permissionMenu.targetPageInstanceId, context.sourcePageInstanceId);
    assert.equal(JSON.stringify(permissionMenu).includes('native/session'), false);
    assert.equal(webchat.resolve({ id: permissionMenu.id, optionId: 'native/session' }, context), false);
    assert.equal(webchat.resolve({ id: permissionMenu.id, optionId: 'choice_0' }, context), true);
    assert.equal(await permission, 'native/deny');
    assert.equal(webchat.resolve({ id: permissionMenu.id, optionId: 'choice_1' }, context), false);
    const modelMenu = menus()[3];
    assert.equal(modelMenu.title, 'Model');
    assert.equal(webchat.resolve({ id: modelMenu.id, optionId: 'choice_0' }, context), true);
    assert.equal(await model, 'provider/model');
});

test('backend resolution and turn cancellation clear active and queued requests without granting late answers', async (t) => {
    const { writes, webchat, native } = setup(t);
    const first = native.request(nativeEvent('first'), { context, turnId: 'one' });
    const queued = native.request(nativeEvent('queued'), { context, turnId: 'one' });
    const unrelated = native.request(nativeEvent('unrelated'), { context: otherContext, turnId: 'two' });
    const firstMenu = writes[0];
    const unrelatedMenu = writes[1];
    native.cancelTurn('one');
    assert.equal(await first, null);
    assert.equal(await queued, null);
    assert.equal(writes.filter((entry) => entry.__webchatInteraction).length, 2);
    assert.equal(webchat.resolve({ id: firstMenu.id, optionId: 'choice_1' }, context), false);
    assert.equal(webchat.resolve({ id: unrelatedMenu.id, optionId: 'choice_0' }, otherContext), true);
    assert.equal(await unrelated, 'native/deny');
    const backend = native.request(nativeEvent('backend'), { context, turnId: 'three' });
    const backendMenu = writes.at(-1);
    assert.equal(native.resolve('backend', 'backend-resolved'), true);
    assert.equal(await backend, null);
    assert.equal(webchat.resolve({ id: backendMenu.id, optionId: 'choice_1' }, context), false);
    assert.equal(native.resolve('backend', 'answered'), false);
});

test('browser cancellation returns null and native disposal does not cancel generic controls', async (t) => {
    const { writes, webchat, native } = setup(t);
    const permission = native.request(nativeEvent('first'), { context, turnId: 'one' });
    const generic = webchat.select({ title: 'Model', options: [{ label: 'A', value: 'a' }] });
    const nativeMenu = writes[0];
    const genericMenu = writes[1];
    assert.equal(webchat.resolve({ id: nativeMenu.id, cancelled: true }, context), true);
    assert.equal(await permission, null);
    native.dispose();
    assert.equal(webchat.resolve({ id: genericMenu.id, optionId: 'choice_0' }), true);
    assert.equal(await generic, 'a');
});

test('ambiguous interaction responses cannot mix selection, input or cancellation', () => {
    const wire = (fields) => JSON.stringify({ __webchatInteractionResponse: 1, version: 1, id: 'request_12345678', ...fields });
    assert.equal(parseWebchatInteractionResponse(wire({ optionId: 'choice_0', response: 'yes' })), null);
    assert.equal(parseWebchatInteractionResponse(wire({ cancelled: true, optionId: 'choice_0' })), null);
    assert.deepEqual(parseWebchatInteractionResponse(wire({ optionId: 'choice_0' })), { id: 'request_12345678', optionId: 'choice_0' });
});
