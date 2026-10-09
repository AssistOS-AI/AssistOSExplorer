import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { AgenticKnowledgeUnits } from 'achillesAgentLib';

import { createWebAssistAgent } from '../src/WebAssistAgent.mjs';
import { appendSessionTurn, updateSessionProfile } from '../src/runtime/update-session.mjs';
import { createWebAssistSandbox, ensureSiteAku } from './helpers.mjs';
import { PRINCIPALS, guestGrant, toolEnvelope, userGrant, verifiedGrant } from './fixtures/verified-grant.mjs';
import { ScriptedPlannerLLM, sessionIdFromRuntimePrompt } from './fixtures/scripted-llm.mjs';

// New product modules are imported per subtest so each subtest fails on its own
// at the pre-change revision (A15).
const SESSION_ACCESS = '../src/runtime/sessionAccess.mjs';
const INDEX = '../src/index.mjs';
const SITE_ID = 'demo-site';
const VICTIM_MARKER = 'VICTIM-CONTACT-MARKER-91c2';
const VICTIM_LEAD_MARKER = 'VICTIM-LEAD-MARKER-4d8e';
const VICTIM_TURN_MARKER = 'VICTIM-TURN-MARKER-55ab';

async function seedSite(t) {
    const sandbox = await createWebAssistSandbox();
    t.after(async () => sandbox.cleanup());
    await ensureSiteAku({ siteId: SITE_ID });
    return sandbox;
}

function siteDir(sandbox) {
    return path.join(sandbox.webAssistDataDir, 'sites', SITE_ID);
}

function ownerPath(sandbox, sessionId) {
    return path.join(siteDir(sandbox), 'session-owners', `${sessionId}.json`);
}

async function kuSnapshot(sandbox, kuId) {
    const aku = new AgenticKnowledgeUnits({ rootDir: siteDir(sandbox), actor: `webassist/${SITE_ID}` });
    await aku.loadAKU();
    try {
        const ku = await aku.loadKU(kuId);
        return JSON.stringify({ state: ku.state || '', events: (ku.events || []).length });
    } catch {
        return 'missing';
    }
}

async function seedVictim(sandbox, sessionId) {
    await appendSessionTurn({ siteId: SITE_ID, sessionId, userMessage: `${VICTIM_TURN_MARKER} hello`, agentResponse: 'hi' });
    await updateSessionProfile({
        siteId: SITE_ID,
        sessionId,
        profileDetails: ['Evaluating a session profile lead'],
        contactInformation: { email: `${VICTIM_MARKER}@example.com`, name: 'Victim Visitor' },
    });
    const { action } = await import('../skills/webassist-lead/src/index.mjs');
    await action({
        promptText: JSON.stringify({ siteId: SITE_ID, sessionId, profile: 'Developer', contactInfo: { phone: VICTIM_LEAD_MARKER } }),
        context: { siteDataDir: siteDir(sandbox), siteId: SITE_ID, sessionId },
    });
}

function wrapExecutePrompt(agent, captured) {
    const original = agent.mainAgent.executePrompt.bind(agent.mainAgent);
    agent.mainAgent.executePrompt = async (runtimePrompt, options = {}) => {
        captured.push({ runtimePrompt, context: options.context });
        return original(runtimePrompt, options);
    };
}

async function chat(grant, input, llm, { tool = 'web_cli_chat' } = {}) {
    const { handleMcpRequest } = await import(INDEX);
    const captured = [];
    const result = await handleMcpRequest(JSON.stringify(toolEnvelope(grant, { siteId: SITE_ID, json: true, ...input }, tool)), {
        createAgent: async () => {
            const agent = await createWebAssistAgent({ llmAgent: llm });
            wrapExecutePrompt(agent, captured);
            return agent;
        },
    });
    const payload = result.exitCode === 0 ? JSON.parse(result.stdout) : null;
    return { ...result, payload, captured };
}

function assertNoVictimData(text, label) {
    for (const marker of [VICTIM_MARKER, VICTIM_LEAD_MARKER, VICTIM_TURN_MARKER]) {
        assert.equal(String(text).includes(marker), false, `${label} contains ${marker}`);
    }
}

test('chat rotates foreign and legacy session ids before context load (A6)', async (t) => {
    const sandbox = await seedSite(t);
    const { createSessionOwner, hashSessionSecret, callerAccessFromEnvelope } = await import(SESSION_ACCESS);
    await seedVictim(sandbox, 'victim-owned');
    await seedVictim(sandbox, 'victim-legacy');
    const victimAccess = await callerAccessFromEnvelope(toolEnvelope(await guestGrant(), {}));
    assert.equal(await createSessionOwner({ siteId: SITE_ID, sessionId: 'victim-owned', access: victimAccess, secretHash: hashSessionSecret('V'.repeat(43)) }), true);

    const attackerGrant = await guestGrant();
    for (const victimId of ['victim-owned', 'victim-legacy']) {
        const before = await kuSnapshot(sandbox, `ku_sess_${victimId}`);
        const llm = new ScriptedPlannerLLM();
        const result = await chat(attackerGrant, { sessionId: victimId, message: 'continue my conversation' }, llm);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.notEqual(result.payload.sessionId, victimId);
        assert.match(result.payload.sessionSecret, /^[A-Za-z0-9_-]{43}$/);
        assertNoVictimData(llm.allCallsText(), 'model calls');
        assert.equal(await kuSnapshot(sandbox, `ku_sess_${victimId}`), before, 'victim session unchanged');
        const owner = JSON.parse(await fs.readFile(ownerPath(sandbox, result.payload.sessionId), 'utf8'));
        assert.equal(owner.id, attackerGrant.actor.id);
        assert.equal(owner.kind, 'guest');
    }
});

test('loadAkuContext excludes other visitors session and lead records (A6b direct)', async (t) => {
    const sandbox = await seedSite(t);
    await seedVictim(sandbox, 'victim-search');
    await updateSessionProfile({ siteId: SITE_ID, sessionId: 'caller-own', profileDetails: ['OWN-PROFILE-MARKER'] });
    const { loadAkuContext } = await import('../src/runtime/load-aku-context.mjs');
    const context = await loadAkuContext({
        siteId: SITE_ID,
        sessionId: 'caller-own',
        message: `session profile lead victim-search Victim Visitor ${VICTIM_MARKER} ${VICTIM_LEAD_MARKER}`,
    });
    assertNoVictimData(JSON.stringify(context), 'loaded context');
    assert.match(context.sessionProfileText, /OWN-PROFILE-MARKER/);
});

test('chat prompt excludes other visitors session and lead records (A6b chat)', async (t) => {
    const sandbox = await seedSite(t);
    await seedVictim(sandbox, 'victim-search');
    const llm = new ScriptedPlannerLLM([
        { tool: 'webassist-site-context', toolPrompt: JSON.stringify({ siteId: SITE_ID, sessionId: 'victim-search', message: 'session profile lead victim-search Victim Visitor' }) },
    ]);
    const result = await chat(await guestGrant(), { message: 'session profile lead victim-search Victim Visitor contact' }, llm);
    assert.equal(result.exitCode, 0, result.stderr);
    assertNoVictimData(llm.allCallsText(), 'model calls');
    assertNoVictimData(JSON.stringify(result.captured), 'runtime prompt');
});

test('chat binds new sessions and lets the owner reuse them (A7, idempotency)', async (t) => {
    const sandbox = await seedSite(t);
    const grant = await guestGrant();
    let ownerSeenAtInference = null;
    const first = new ScriptedPlannerLLM([], {
        onComplete: async ({ userPrompt, callIndex }) => {
            if (callIndex !== 0) return;
            const sessionId = sessionIdFromRuntimePrompt(userPrompt);
            ownerSeenAtInference = JSON.parse(await fs.readFile(ownerPath(sandbox, sessionId), 'utf8'));
        },
    });
    const created = await chat(grant, { message: 'first turn' }, first);
    assert.equal(created.exitCode, 0, created.stderr);
    assert.equal(ownerSeenAtInference?.id, grant.actor.id, 'owner record exists before inference');
    assert.ok(created.payload.sessionSecret);

    const replay = await chat(grant, { sessionId: created.payload.sessionId, message: 'second turn' }, new ScriptedPlannerLLM());
    assert.equal(replay.exitCode, 0, replay.stderr);
    assert.equal(replay.payload.sessionId, created.payload.sessionId);
    assert.equal(Object.hasOwn(replay.payload, 'sessionSecret'), false, 'reuse never returns a secret');
    assert.match(JSON.stringify(replay.captured), /first turn/);

    const { getSessionHistory } = await import('../src/mcp/get-session-history.mjs');
    const { callerAccessFromEnvelope } = await import(SESSION_ACCESS);
    const history = await getSessionHistory({ siteId: SITE_ID, sessionId: created.payload.sessionId, access: await callerAccessFromEnvelope(toolEnvelope(grant, {})) });
    assert.equal(history.history.length, 4);
});

test('skills use the trusted session and ignore model-supplied ids (A16 direct)', async (t) => {
    const sandbox = await seedSite(t);
    await seedVictim(sandbox, 'victim-skill');
    const victimSession = await kuSnapshot(sandbox, 'ku_sess_victim-skill');
    const victimLead = await kuSnapshot(sandbox, 'ku_lead_victim-skill');
    const context = { siteDataDir: siteDir(sandbox), siteId: SITE_ID, sessionId: 'caller-skill' };
    const session = await import('../skills/webassist-session/src/index.mjs');
    const lead = await import('../skills/webassist-lead/src/index.mjs');
    const siteContext = await import('../skills/webassist-site-context/src/index.mjs');

    await session.action({ promptText: JSON.stringify({ siteId: 'other-site', sessionId: 'victim-skill', contactInformation: { email: 'attacker@example.com' } }), context });
    await lead.action({ promptText: JSON.stringify({ siteId: 'other-site', sessionId: 'victim-skill', profile: 'Developer', contactInfo: { email: 'attacker@example.com' } }), context });
    assert.equal(await kuSnapshot(sandbox, 'ku_sess_victim-skill'), victimSession, 'victim session unchanged');
    assert.equal(await kuSnapshot(sandbox, 'ku_lead_victim-skill'), victimLead, 'victim lead unchanged');
    assert.match(await kuSnapshot(sandbox, 'ku_sess_caller-skill'), /attacker@example\.com/);
    assert.match(await kuSnapshot(sandbox, 'ku_lead_caller-skill'), /attacker@example\.com/);

    const contextText = await siteContext.action({ promptText: JSON.stringify({ sessionId: 'victim-skill', message: 'session profile lead victim-skill' }), context });
    assertNoVictimData(contextText, 'site context');

    for (const skill of [session, lead, siteContext]) {
        await assert.rejects(skill.action({
            promptText: JSON.stringify({ siteId: SITE_ID, sessionId: 'victim-skill', profile: 'Developer', contactInfo: { email: 'x@example.com' } }),
            context: { siteDataDir: siteDir(sandbox) },
        }), /context/);
    }
    assert.equal(await kuSnapshot(sandbox, 'ku_sess_victim-skill'), victimSession);
});

test('chat skills cannot write another visitor session or lead (A16 chat)', async (t) => {
    const sandbox = await seedSite(t);
    await seedVictim(sandbox, 'victim-chat');
    const victimSession = await kuSnapshot(sandbox, 'ku_sess_victim-chat');
    const victimLead = await kuSnapshot(sandbox, 'ku_lead_victim-chat');
    const llm = new ScriptedPlannerLLM([
        { tool: 'webassist-session', toolPrompt: JSON.stringify({ siteId: SITE_ID, sessionId: 'victim-chat', contactInformation: { email: 'attacker@example.com' } }) },
        { tool: 'webassist-lead', toolPrompt: JSON.stringify({ siteId: SITE_ID, sessionId: 'victim-chat', profile: 'Developer', contactInfo: { email: 'attacker@example.com' } }) },
    ]);
    const result = await chat(await guestGrant(), { message: 'I am attacker@example.com' }, llm);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(await kuSnapshot(sandbox, 'ku_sess_victim-chat'), victimSession);
    assert.equal(await kuSnapshot(sandbox, 'ku_lead_victim-chat'), victimLead);
    const own = result.payload.sessionId;
    assert.match(await kuSnapshot(sandbox, `ku_sess_${own}`), /attacker@example\.com/);
    assert.match(await kuSnapshot(sandbox, `ku_lead_${own}`), /attacker@example\.com/);
    for (const call of result.captured) {
        assert.deepEqual(Object.keys(call.context).sort(), ['sessionId', 'siteDataDir', 'siteId']);
        assert.equal(call.context.sessionId, own);
        assert.equal(call.context.siteId, SITE_ID);
    }
});

test('a session secret continues the conversation for a different principal (A17 chat)', async (t) => {
    await seedSite(t);
    const created = await chat(await guestGrant(), { message: 'OWNER-FIRST-TURN-MARKER' }, new ScriptedPlannerLLM());
    assert.equal(created.exitCode, 0, created.stderr);
    const { sessionId, sessionSecret } = created.payload;

    const rotatedGuest = await guestGrant();
    const llm = new ScriptedPlannerLLM();
    const continued = await chat(rotatedGuest, { sessionId, sessionSecret, message: 'next turn' }, llm);
    assert.equal(continued.exitCode, 0, continued.stderr);
    assert.equal(continued.payload.sessionId, sessionId);
    assert.equal(Object.hasOwn(continued.payload, 'sessionSecret'), false);
    assert.match(llm.allCallsText(), /OWNER-FIRST-TURN-MARKER/);

    const { getSessionHistory } = await import('../src/mcp/get-session-history.mjs');
    const { callerAccessFromEnvelope } = await import(SESSION_ACCESS);
    const history = await getSessionHistory({ siteId: SITE_ID, sessionId, sessionSecret, access: await callerAccessFromEnvelope(toolEnvelope(rotatedGuest, {})) });
    assert.equal(history.exists, true);
    assert.equal(history.history.length, 4);
});

test('a wrong, malformed or absent secret rotates the session (A18 chat)', async (t) => {
    await seedSite(t);
    const created = await chat(await guestGrant(), { message: 'OWNER-PRIVATE-MARKER' }, new ScriptedPlannerLLM());
    const { sessionId, sessionSecret } = created.payload;
    const other = await guestGrant();
    for (const candidate of [undefined, '', `${sessionSecret.slice(0, -1)}A`, 'short', 'x'.repeat(5000)]) {
        const llm = new ScriptedPlannerLLM();
        const result = await chat(other, { sessionId, ...(candidate === undefined ? {} : { sessionSecret: candidate }), message: 'hello' }, llm);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.notEqual(result.payload.sessionId, sessionId);
        assert.match(result.payload.sessionSecret, /^[A-Za-z0-9_-]{43}$/);
        assert.notEqual(result.payload.sessionSecret, sessionSecret);
        assert.equal(llm.allCallsText().includes('OWNER-PRIVATE-MARKER'), false);
    }
});

test('concurrent new chats get distinct owned sessions', async (t) => {
    const sandbox = await seedSite(t);
    const grants = [await guestGrant(), await guestGrant()];
    const results = await Promise.all(grants.map((grant) => chat(grant, { message: 'hello' }, new ScriptedPlannerLLM())));
    assert.notEqual(results[0].payload.sessionId, results[1].payload.sessionId);
    for (const [index, result] of results.entries()) {
        const owner = JSON.parse(await fs.readFile(ownerPath(sandbox, result.payload.sessionId), 'utf8'));
        assert.equal(owner.id, grants[index].actor.id);
    }
});

test('chat input and caller validation fails closed with public errors', async (t) => {
    const sandbox = await seedSite(t);
    const empty = await chat(await guestGrant(), { sessionId: '', message: 'hello' }, new ScriptedPlannerLLM());
    assert.equal(empty.exitCode, 0, empty.stderr);
    assert.match(empty.payload.sessionId, /^session-\d{8}T\d{9}Z-[0-9a-f]{32}$/);

    for (const sessionId of ['a'.repeat(129), '../x', 'a.b', 'sess-ü', '-x']) {
        const result = await chat(await guestGrant(), { sessionId, message: 'hello' }, new ScriptedPlannerLLM());
        assert.equal(result.exitCode, 1);
        assert.equal(result.stderr.trim(), 'Invalid sessionId.');
    }
    const owners = await fs.readdir(path.join(siteDir(sandbox), 'session-owners'));
    assert.ok(owners.every((name) => /^session-[A-Za-z0-9-]+\.json$/.test(name)), owners.join(','));

    const malformedGrants = [
        undefined,
        'not-an-object',
        await verifiedGrant({ sub: 'agent:AchillesIDE/explorer', actor: { kind: 'agent', id: 'agent:AchillesIDE/explorer', roles: [] } }),
        await verifiedGrant({ sub: 'user:member-1', actor: { kind: 'user', id: 'user:member-2', roles: ['user'] } }),
    ];
    for (const grant of malformedGrants) {
        const result = await chat(grant, { message: 'hello' }, new ScriptedPlannerLLM());
        assert.equal(result.exitCode, 1);
        assert.equal(result.stderr.trim(), 'Access denied: a verified visitor or user is required.');
    }
});

test('chat storage errors are generic for guests and detailed for admins', async (t) => {
    const sandbox = await createWebAssistSandbox();
    t.after(async () => sandbox.cleanup());
    const outside = path.join(sandbox.sandboxRoot, 'outside');
    await fs.mkdir(outside);
    await fs.rm(sandbox.webAssistDataDir, { recursive: true });
    await fs.symlink(outside, sandbox.webAssistDataDir);
    const previous = process.env.ACHILLES_DEBUG;
    delete process.env.ACHILLES_DEBUG;
    t.after(() => {
        if (previous === undefined) delete process.env.ACHILLES_DEBUG;
        else process.env.ACHILLES_DEBUG = previous;
    });
    const guest = await chat(await guestGrant(), { message: 'hello' }, new ScriptedPlannerLLM());
    assert.equal(guest.exitCode, 1);
    assert.equal(guest.stderr.trim(), 'webAssist request failed.');
    const admin = await chat(await userGrant(PRINCIPALS.admin), { message: 'hello' }, new ScriptedPlannerLLM());
    assert.equal(admin.exitCode, 1);
    assert.match(admin.stderr, /symbolic link/);
});
