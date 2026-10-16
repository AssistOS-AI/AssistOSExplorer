import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { skillCatalogRequest } from '../server/skill-catalog-api.mjs';
import { DEFAULT_ROBOT_ID, OTHER_ROBOT_ID, SKILL_IDENTITY, createConversationSkillsFixture } from './helpers/conversation-skills-fixture.mjs';

const MISMATCH = 'This conversation uses another robot. Open it with that robot, or create a new session.';

async function setup(t) {
    const f = await createConversationSkillsFixture();
    t.after(() => f.close());
    return { ...f, robot: await f.robotStore.get(DEFAULT_ROBOT_ID), other: await f.robotStore.get(OTHER_ROBOT_ID) };
}

test('an unknown conversation is reported as not found, never as robot defaults', async t => {
    const f = await setup(t);
    const request = skillCatalogRequest({ skillsets: f.skillsets, robot: f.robot, input: { sessionId: crypto.randomUUID() } });
    await assert.rejects(request, { statusCode: 404, message: 'Conversation is unavailable in registered projects' });
});

test('a conversation bound to another robot is refused on read and on mutation without touching either robot', async t => {
    const f = await setup(t);
    const { sessionId } = await f.addSession({ robotId: DEFAULT_ROBOT_ID });
    const before = await f.policyFiles(OTHER_ROBOT_ID);
    await assert.rejects(skillCatalogRequest({ skillsets: f.skillsets, robot: f.other, input: { sessionId } }),
        { statusCode: 409, message: MISMATCH });
    await assert.rejects(skillCatalogRequest({ skillsets: f.skillsets, robot: f.other,
        input: { sessionId, identity: SKILL_IDENTITY, enabled: true, policyVersion: 1 }, mutate: true }),
    { statusCode: 409, message: MISMATCH });
    assert.deepEqual(await f.policyFiles(OTHER_ROBOT_ID), before);
    assert.deepEqual(await f.policyFiles(OTHER_ROBOT_ID), []);
});

test('guard (passes at baseline): the owning robot reads a bound conversation and an unbound conversation is accepted', async t => {
    const f = await setup(t);
    const bound = await f.addSession({ robotId: DEFAULT_ROBOT_ID });
    const unbound = await f.addSession({ engine: null });
    for (const { sessionId } of [bound, unbound]) {
        const catalog = await skillCatalogRequest({ skillsets: f.skillsets, robot: f.robot, input: { sessionId } });
        assert.equal(catalog.scope, 'conversation');
        assert.equal(catalog.sessionId, sessionId);
        assert.ok(catalog.skills.some(skill => skill.identity === SKILL_IDENTITY));
    }
});

test('guard (passes at baseline): without a conversation the tool still reads robot defaults', async t => {
    const f = await setup(t);
    const catalog = await skillCatalogRequest({ skillsets: f.skillsets, robot: f.robot, input: {} });
    assert.equal(catalog.scope, 'defaults');
    assert.equal(catalog.sessionId, null);
});

test('a conversation record can only refer to its own policy, never to robot defaults or another policy', async t => {
    const f = await setup(t);
    const { policyId: defaultsId } = await f.skillsets.defaults(f.robot);
    await f.skillsets.policies.ensure(f.robot, defaultsId, { useDefaults: false });
    const defaultsBefore = await f.digest(f.policyFile(DEFAULT_ROBOT_ID, defaultsId));
    const defaultsVersion = (await f.skillsets.policies.read(DEFAULT_ROBOT_ID, defaultsId)).policyVersion;
    const foreign = crypto.randomUUID();
    await f.skillsets.policies.ensure(f.robot, foreign, { useDefaults: false });
    for (const ref of [defaultsId, foreign, {}, 5]) {
        const { sessionId } = await f.addSession({ extra: { skillPolicyRef: ref } });
        await assert.rejects(skillCatalogRequest({ skillsets: f.skillsets, robot: f.robot, input: { sessionId } }),
            { statusCode: 400, message: 'invalid conversation skill policy reference' }, JSON.stringify(ref));
        await assert.rejects(skillCatalogRequest({ skillsets: f.skillsets, robot: f.robot,
            input: { sessionId, identity: SKILL_IDENTITY, enabled: true, policyVersion: defaultsVersion }, mutate: true }),
        { statusCode: 400, message: 'invalid conversation skill policy reference' }, JSON.stringify(ref));
    }
    assert.equal(await f.digest(f.policyFile(DEFAULT_ROBOT_ID, defaultsId)), defaultsBefore);
    const selfId = crypto.randomUUID();
    const none = await f.addSession();
    const self = await f.addSession({ sessionId: selfId, extra: { skillPolicyRef: selfId } });
    for (const id of [none.sessionId, self.sessionId]) {
        const catalog = await skillCatalogRequest({ skillsets: f.skillsets, robot: f.robot, input: { sessionId: id } });
        assert.equal(catalog.scope, 'conversation');
    }
});
