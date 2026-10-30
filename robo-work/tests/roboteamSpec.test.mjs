import assert from 'node:assert/strict';
import test from 'node:test';

import { planAlaExecution } from '../server/runtime/alaPlan.mjs';
import { validateSpecificationV2 } from '../server/stateProtocol.mjs';
import { LIMITS } from './helpers/synthetic.mjs';
import { roboTeamSpecification } from './helpers/roboteamSpec.mjs';

// Cross-side check: what RoboTeam's worker engine really sends is valid for the worker's validator and is accepted by the plan.
// Extend with more `roboTeamSpecification` options (see the helper) as RoboTeam gains inputs.
const LIMITS_X = Object.freeze({ ...LIMITS, requestBytes: 4 * 1024 * 1024 });

test('the specification built by RoboTeam passes the v2 validator and the plan', async (t) => {
    const built = await roboTeamSpecification({ prompt: 'Summarize the repo' });
    t.after(built.cleanup);
    const { specification } = built;
    validateSpecificationV2(specification, LIMITS_X);
    assert.equal(specification.version, 2);
    assert.equal(specification.cwd, built.cwd);
    assert.match(specification.prompt, /Summarize the repo/u);
    // The project lies below the workspace root, so the plan grants it and nothing else.
    const plan = planAlaExecution({ specification, workspaceRoot: built.workspaceRoot });
    assert.equal(plan.cwd, '/projects/g0');
    assert.deepEqual(plan.grants.map((grant) => [grant.path, grant.access]), [['/projects/g0', 'write']]);
    assert.deepEqual(plan.argv.slice(plan.argv.indexOf('--ignore')), ['--ignore', '/projects/g0/.roboteam']);
});

test('M-20 no project selected: RoboTeam sends no cwd, the worker plans no grant and starts ALA in the robot HOME', async (t) => {
    const built = await roboTeamSpecification({ cwdIsWorkspaceRoot: true });
    t.after(built.cleanup);
    assert.equal(built.specification.cwd, undefined);
    validateSpecificationV2(built.specification, LIMITS_X);
    const plan = planAlaExecution({ specification: built.specification, workspaceRoot: built.workspaceRoot });
    assert.deepEqual([...plan.grants], []);
    assert.equal(plan.cwd, '/home/robot');
    assert.equal(plan.argv[plan.argv.indexOf('--cwd') + 1], '/home/robot');
    assert.equal(plan.argv.includes('--folder'), false);
});

test('M-20 root selected: the worker refuses a cwd, a folder or an ignore-less grant equal to the workspace root', async (t) => {
    const built = await roboTeamSpecification({ cwdIsWorkspaceRoot: true });
    t.after(built.cleanup);
    const refusal = (overrides) => {
        try { planAlaExecution({ specification: { ...built.specification, ...overrides }, workspaceRoot: built.workspaceRoot }); } catch (error) { return error.reason; }
        return null;
    };
    assert.equal(refusal({ cwd: built.workspaceRoot }), 'workspace_root_not_granted');
    assert.equal(refusal({ folders: [{ path: built.workspaceRoot, access: 'read' }] }), 'workspace_root_not_granted');
    assert.equal(refusal({ cwd: `${built.workspaceRoot}/project`, folders: [{ path: built.workspaceRoot, access: 'read' }] }), 'workspace_root_not_granted');
    assert.equal(refusal({ folders: [{ path: '/', access: 'read' }] }), 'path_outside_workspace');
    // The RoboTeam side (it refuses before admission) is asserted by its own tests.
});
