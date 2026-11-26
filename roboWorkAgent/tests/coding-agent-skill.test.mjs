import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installCodingAgentSkill } from '../server/coding-agent-skill.mjs';
import { codingAgentSkillDirectory } from '../server/coding-agents.mjs';
import { codingSessionInput } from '../server/terminal-profiles.mjs';

async function home(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-skill-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

test('a role skill lands in the agent skill directory and replaces its earlier text', async t => {
    const directory = await home(t);
    assert.equal(codingAgentSkillDirectory('claude'), '.claude/skills');
    assert.equal(codingAgentSkillDirectory('vibe'), '.vibe/skills');
    // An agent without that convention installs nothing and reports it.
    assert.deepEqual(await installCodingAgentSkill(directory, { codingAgent: 'codex', name: 'supervised-session', text: '# Worker\n' }),
        { installed: false });
    assert.deepEqual(await fs.readdir(directory), []);
    assert.deepEqual(await installCodingAgentSkill(directory, { codingAgent: 'claude', name: 'supervised-session', text: '# Supervisor\n' }),
        { installed: true });
    const file = path.join(directory, '.claude', 'skills', 'supervised-session', 'SKILL.md');
    assert.equal(await fs.readFile(file, 'utf8'), '# Supervisor\n');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o644);
    // A later launch with the other role rewrites the same name; no staging file survives.
    await installCodingAgentSkill(directory, { codingAgent: 'claude', name: 'supervised-session', text: '# Supervisor\nrevised\n' });
    assert.equal(await fs.readFile(file, 'utf8'), '# Supervisor\nrevised\n');
    assert.deepEqual((await fs.readdir(path.dirname(file))).filter(name => name.endsWith('.tmp')), []);
});

test('an invalid skill request is refused before anything is written', async t => {
    const directory = await home(t);
    for (const input of [
        { codingAgent: 'vim', name: 'supervised-session', text: 'x' },
        { codingAgent: 'claude', name: 'Supervised Session', text: 'x' },
        { codingAgent: 'claude', name: 'ok', text: '   ' },
        { codingAgent: 'claude', name: 'ok' },
        { codingAgent: 'claude', name: 'ok', text: 'x'.repeat(64 * 1024 + 1) },
    ]) {
        await assert.rejects(installCodingAgentSkill(directory, input), { code: 'INVALID_INPUT' });
    }
    assert.deepEqual(await fs.readdir(directory), []);
});

test('a launch body keeps its role skill optional and refuses anything else', () => {
    const base = { robot: 'robot-a', codingAgent: 'claude', directory: 'project', resume: null };
    // A caller that briefs with a prompt sends exactly the original four keys.
    assert.deepEqual(codingSessionInput('launch', base), { ...base, skill: null });
    const skill = { name: 'supervised-session', text: '# Worker\n' };
    assert.deepEqual(codingSessionInput('launch', { ...base, skill }),
        { ...base, skill });
    // Skills remain optional; native session instructions use systemPrompt.
    assert.deepEqual(codingSessionInput('launch', { ...base, skill: null }),
        { ...base, skill: null });
    for (const body of [
        { ...base, role: 'reviewer' },
        { ...base, extra: true },
        { ...base, skill: { name: 'ok' } },
        { ...base, skill: { name: 'ok', text: 'x', more: 1 } },
        { ...base, skill: { name: 'supervised-session', text: 'x'.repeat(64 * 1024 + 1) } },
    ]) {
        assert.equal(codingSessionInput('launch', body), null, JSON.stringify(body).slice(0, 80));
    }
});
