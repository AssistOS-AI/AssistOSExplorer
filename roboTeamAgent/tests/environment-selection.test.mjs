import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeWorkflow } from '../server/roboflow/graph.mjs';
import { discoverWorkflowSkillsets } from '../server/roboflow/skill-matching.mjs';
import { createWorkerClient } from '../server/worker-coordinator/worker-client.mjs';
import { createWorkerCoordinatorHop } from '../server/worker-coordinator/hop.mjs';
import { addEnvironmentSkills, environmentPickerChoices, recommendedEnvironmentSkills } from '../public/workflow-editor.js';

const task = { id: 'phase', name: 'Phase', prompt: 'Work', executionType: 'terminal', skillsets: [] };
const graph = (entry) => ({ id: 'environment', name: 'Environment', description: 'Work', tasks: [entry], edges: [] });

test('only terminal workflow phases accept string repo/agent Environment references', () => {
    for (const environment of ['', 'repo/agent', `${'r'.repeat(128)}/${'a'.repeat(128)}`, 'repo._-1/agent._-2']) {
        const normalized = normalizeWorkflow(graph({ ...task, environment }));
        assert.equal(normalized.tasks[0].environment, environment || undefined);
    }
    for (const environment of [null, 1, {}, ['repo/agent'], 'repo', 'repo/agent/other', '/agent', 'repo/', 'repo/a b', `${'r'.repeat(129)}/a`, 'repo/agent\n']) {
        assert.throws(() => normalizeWorkflow(graph({ ...task, environment })), /repo\/agent/);
    }
    for (const executionType of ['desktop', 'browser']) {
        assert.throws(() => normalizeWorkflow(graph({ ...task, executionType, environment: 'repo/agent' })), /only terminal/);
    }
    assert.throws(() => normalizeWorkflow(graph({ ...task, environment: 'repo/agent' }), { builtin: true }), /only terminal/);
    assert.throws(() => normalizeWorkflow(graph({ id: 'run-workflows', kind: 'run-workflows', environment: 'repo/agent' })), /only terminal/);
});

test('recommendations identify mixed root repositories and add without removing or duplicating selected skills', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'environment-skills-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const name of ['mixed', 'skills', 'agents']) await fs.mkdir(path.join(root, name, 'skills', 'review'), { recursive: true });
    const catalog = await discoverWorkflowSkillsets({ listRepositories: async () => ['mixed', 'skills', 'agents'].map(kind => ({
        name: kind, kind, origin: 'workspace', source: path.join(root, kind),
    })) });
    assert.deepEqual(catalog.diagnostics, []);
    assert.equal(catalog.skillsets.find(entry => entry.repositoryName === 'mixed').repositoryKind, 'mixed');
    assert.equal(catalog.skillsets.some(entry => entry.repositoryName === 'agents'), false);
    const recommended = recommendedEnvironmentSkills('mixed/agent', catalog.skillsets);
    assert.equal(recommended.length, 1);
    assert.deepEqual(recommendedEnvironmentSkills('skills/agent', catalog.skillsets), []);
    const current = { skillsets: ['chosen-elsewhere'] };
    addEnvironmentSkills(current, recommended);
    addEnvironmentSkills(current, recommended);
    assert.deepEqual(current.skillsets, ['chosen-elsewhere', recommended[0].id]);
});

test('unavailable and missing saved selections retain their value and explanatory text', () => {
    const environments = [{ ref: 'repo/agent', available: false, reason: 'image_musl', about: 'An image' }];
    const choices = environmentPickerChoices(environments, 'saved/disabled');
    assert.equal(choices[0].label, 'Worker (default)');
    assert.equal(choices[1].disabled, true);
    assert.match(choices[1].label, /image_musl/);
    assert.match(choices[1].title, /image_musl/);
    assert.deepEqual(choices.at(-1), { value: 'saved/disabled', label: 'saved/disabled (missing)', disabled: true,
        title: 'The saved environment is no longer listed as an enabled global container agent.' });
    assert.equal(environmentPickerChoices(environments, 'repo/agent').filter(entry => entry.value === 'repo/agent').length, 1);
});

test('environment discovery crosses only the authenticated coordinator read with an empty body', async (t) => {
    const seen = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ environments: [{ ref: 'repo/agent', available: true }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const hop = createWorkerCoordinatorHop({ routerUrl: `http://127.0.0.1:${server.address().port}`, env: {
        ROBOTEAM_WORKER_COORDINATOR_BASE: '/base-agent-additional-server/robo-work/7311',
        PLOINKY_AGENT_ID: 'agent:AchillesIDE/roboTeamAgent', PLOINKY_AGENT_INSTANCE_ID: 'instance',
        PLOINKY_AGENT_ENABLE_GENERATION: 'generation', PLOINKY_AGENT_PRIVATE_SECRET: 'a'.repeat(64),
    }, libraries: { assertion: { signPrivateRouterAssertion: input => {
        assert.equal(input.path, '/base-agent-additional-server/robo-work/7311/v1/coordinator/environments/list');
        assert.equal(input.body.toString(), '{}');
        return 'signed-test-assertion';
    } } } });
    const result = await createWorkerClient({ hop }).environments();
    assert.equal(result.environments[0].ref, 'repo/agent');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].body, '{}');
    assert.equal(seen[0].headers['ploinky-agent-assertion'], 'signed-test-assertion');
    assert.equal(seen[0].headers['x-ploinky-user-delegation'], undefined);
    await assert.rejects(hop.call('environments/execute', {}), { code: 'invalid_request' });
});
