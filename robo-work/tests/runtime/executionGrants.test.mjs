import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { grantRoleFor } from '../../server/runtime/executionFactory.mjs';
import { planAlaExecution } from '../../server/runtime/alaPlan.mjs';
import { resolveGrant } from '../../server/views/grantResolver.mjs';

// The grant role of each plan grant, through the REAL anchored grant resolver on a real directory tree: a read-only folder under
// `.ploinky/repos/<repo>/` is a skill source, protected names stay refused, a writable cwd is always a project.
function workspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rw-grants-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const directory of ['.ploinky/repos/AssistOS/skills/search', '.ploinky/repos/Other/skills', 'proj/sub', 'proj/.roboteam/skills', 'outside/secret']) fs.mkdirSync(path.join(root, directory), { recursive: true });
    // A symlink inside a repo that points outside it, and a repo that is itself a link to another place.
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, '.ploinky/repos/AssistOS/skills/escape'));
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, '.ploinky/repos/Linked'));
    return root;
}
const SPEC = (root, overrides = {}) => ({
    version: 2, prompt: 'p', displayText: 'd', sessionId: 's', turnId: 't', cwd: undefined, permissions: 'full-access', ...overrides
});

async function resolveAll(root, specification) {
    const plan = planAlaExecution({ workspaceRoot: root, specification });
    const outcomes = [];
    for (const entry of plan.grants) {
        const result = await resolveGrant({ role: grantRoleFor(entry), access: entry.access, relativePath: entry.relativePath }, { workspaceRoot: root });
        outcomes.push([entry.relativePath, grantRoleFor(entry), entry.access, result.ok ? 'ok' : result.code]);
        if (result.ok) await result.grant.close();
    }
    return outcomes;
}

test('a skill source under .ploinky/repos resolves as a read-only skill-source; a project subfolder and the cwd resolve as projects', async (t) => {
    const root = workspace(t);
    const specification = SPEC(root, {
        cwd: path.join(root, 'proj'),
        folders: [{ path: path.join(root, '.ploinky/repos/AssistOS/skills/search'), access: 'read' }, { path: path.join(root, 'proj/sub'), access: 'read' }]
    });
    assert.deepEqual(await resolveAll(root, specification), [
        ['proj', 'project', 'write', 'ok'],
        ['.ploinky/repos/AssistOS/skills/search', 'skill-source', 'read', 'ok'],
        ['proj/sub', 'project', 'read', 'ok']
    ]);
});

test('protected names and managed sources stay refused: .roboteam, a writable managed source, the repos tree itself and the wrong role', async (t) => {
    const root = workspace(t);
    const outcome = async (folder) => (await resolveAll(root, SPEC(root, { cwd: path.join(root, 'proj'), folders: [folder] })))[1];
    assert.deepEqual(await outcome({ path: path.join(root, 'proj/.roboteam/skills'), access: 'read' }), ['proj/.roboteam/skills', 'project', 'read', 'protected_component']);
    assert.deepEqual(await outcome({ path: path.join(root, '.ploinky/repos/AssistOS/skills/search'), access: 'write' }), ['.ploinky/repos/AssistOS/skills/search', 'project', 'write', 'managed_source_writable']);
    assert.deepEqual(await outcome({ path: path.join(root, '.ploinky/repos'), access: 'read' }), ['.ploinky/repos', 'project', 'read', 'managed_source_not_project']);
    assert.deepEqual(await outcome({ path: path.join(root, '.ploinky/repos/AssistOS'), access: 'read' }), ['.ploinky/repos/AssistOS', 'skill-source', 'read', 'ok']);
    assert.deepEqual(await outcome({ path: path.join(root, '.ploinky/data'), access: 'read' }), ['.ploinky/data', 'project', 'read', 'protected_component']);
    // M-22: nothing else under .ploinky resolves, and a link is never followed (an escape link, a linked repo, a path through either).
    assert.deepEqual(await outcome({ path: path.join(root, '.ploinky'), access: 'read' }), ['.ploinky', 'project', 'read', 'protected_component']);
    assert.deepEqual(await outcome({ path: path.join(root, '.ploinky/repos/AssistOS/skills/escape'), access: 'read' }), ['.ploinky/repos/AssistOS/skills/escape', 'skill-source', 'read', 'symlink_in_path']);
    assert.deepEqual(await outcome({ path: path.join(root, '.ploinky/repos/AssistOS/skills/escape/secret'), access: 'read' }), ['.ploinky/repos/AssistOS/skills/escape/secret', 'skill-source', 'read', 'symlink_in_path']);
    assert.deepEqual(await outcome({ path: path.join(root, '.ploinky/repos/Linked'), access: 'read' }), ['.ploinky/repos/Linked', 'skill-source', 'read', 'symlink_in_path']);
    // A protected name below a repo is refused in the skill view too.
    fs.mkdirSync(path.join(root, '.ploinky/repos/AssistOS/.roboteam'), { recursive: true });
    assert.deepEqual(await outcome({ path: path.join(root, '.ploinky/repos/AssistOS/.roboteam'), access: 'read' }), ['.ploinky/repos/AssistOS/.roboteam', 'skill-source', 'read', 'protected_component']);
    // The case-folded spelling takes the same route; a writable cwd is a project whatever its name.
    assert.equal(grantRoleFor({ relativePath: '.PLOINKY/repos/R/x', access: 'read' }), 'skill-source');
    assert.equal(grantRoleFor({ relativePath: '.ploinky/repos/R/x', access: 'write' }), 'project');
    assert.equal(grantRoleFor({ relativePath: 'proj', access: 'write' }), 'project');
});
