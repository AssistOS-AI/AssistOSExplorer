import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { codingSessionArguments, listCodingSessions, presetsSessionId } from '../server/coding-sessions.mjs';

// The linked ALA checkout beside this repository, as the RoboWork container mounts it.
const alaRoot = fileURLToPath(new URL('../../../AdvancedLanguageAgent', import.meta.url));
const alaPresent = await fs.access(path.join(alaRoot, 'src', 'coding-agents', 'agents', 'pi', 'sessions.mjs')).then(() => true, () => false);

test('the home helper lists the folder conversations through the ALA catalog of the agent', { skip: !alaPresent && 'ALA checkout is not beside this repository' }, async t => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-sessions-'));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const directory = path.join(home, '.pi', 'agent', 'sessions', '--work-project--');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, '1_a.jsonl'), [
        { type: 'session', version: 3, id: 'abc-1', timestamp: '2026-01-01T00:00:00Z', cwd: '/work/project' },
        { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello pi' }] } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const { sessions } = await listCodingSessions(home, { codingAgent: 'pi', cwd: '/work/project' }, { alaRoot });
    assert.deepEqual(sessions.map(({ id, title }) => [id, title]), [['abc-1', 'hello pi']]);
    await assert.rejects(listCodingSessions(home, { codingAgent: 'pi', cwd: 'relative' }, { alaRoot }), { code: 'INVALID_INPUT' });
    await assert.rejects(listCodingSessions(home, { codingAgent: 'vim', cwd: '/work' }, { alaRoot }), { code: 'UNKNOWN_CODING_AGENT' });
    assert.deepEqual(await codingSessionArguments(alaRoot, 'codex', { resume: 'thread-1' }), ['resume', 'thread-1']);
    assert.deepEqual(await codingSessionArguments(alaRoot, 'opencode'), []);
    assert.equal(await presetsSessionId(alaRoot, 'claude'), true);
    assert.equal(await presetsSessionId(alaRoot, 'opencode'), false);
    // OMP resumes by session identifier and lists nothing when it has no catalog folder yet.
    assert.deepEqual(await listCodingSessions(home, { codingAgent: 'omp', cwd: '/work/project' }, { alaRoot }), { sessions: [] });
    assert.deepEqual(await codingSessionArguments(alaRoot, 'omp', { resume: 'omp-1' }), ['--resume', 'omp-1']);
    assert.equal(await presetsSessionId(alaRoot, 'omp'), false);
    assert.deepEqual(await listCodingSessions(home, { codingAgent: 'vibe', cwd: '/work/project' }, { alaRoot }),
        { sessions: [], sessionBindingSupported: true });
});
