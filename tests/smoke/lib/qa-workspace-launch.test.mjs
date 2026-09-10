import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url), 'utf8');
const start = workflow.indexOf('          mkdir -p "$WORK_DIR"\n');
const end = workflow.indexOf('          node --input-type=module - "$WORK_DIR/.env"', start);
assert.ok(start > 0 && end > start, 'the guarded workspace bootstrap must exist');
const bootstrap = workflow.slice(start, end).replace(/^ {10}/gm, '');

test('QA host commands inherit the selected workspace instead of the SSH login directory', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-workspace-launch-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const login = path.join(root, 'ssh home');
    const workspace = path.join(login, 'selected workspace');
    const skill = '.agents/skills/local/SKILL.md';
    fs.mkdirSync(path.join(workspace, path.dirname(skill)), { recursive: true });
    fs.writeFileSync(path.join(workspace, skill), 'selected workspace skill\n');
    const probe = path.join(root, 'probe.mjs');
    fs.writeFileSync(probe, `import fs from 'node:fs';
process.stdout.write(JSON.stringify({
    cwd: fs.realpathSync(process.cwd()),
    workspace: fs.realpathSync(process.env.PLOINKY_WORKSPACE_ROOT),
    skill: fs.existsSync(${JSON.stringify(skill)}) ? fs.readFileSync(${JSON.stringify(skill)}, 'utf8') : null,
}));
`);
    const result = spawnSync('bash', ['-c', `set -euo pipefail\n${bootstrap}
export PLOINKY_WORKSPACE_ROOT="$WORK_DIR"
"$NODE" "$PROBE"
`], {
        cwd: login,
        encoding: 'utf8',
        env: { ...process.env, WORK_DIR: workspace, NODE: process.execPath, PROBE: probe },
        timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
        cwd: fs.realpathSync(workspace),
        workspace: fs.realpathSync(workspace),
        skill: 'selected workspace skill\n',
    });
});

test('QA enters its guarded workspace before all host Ploinky entry points', () => {
    const admission = workflow.indexOf('          cd "$WORK_DIR"\n', start);
    assert.ok(admission > start && admission < end, 'enter the new workspace before staging runtime state');
    assert.ok(workflow.indexOf('Exact prior Explorer QA deployment cleanup verified.') < admission);
    for (const entry of [
        '          inspect_outer_box_status() {',
        '"$RUNTIME_DIR/bin/ploinky" stop',
        '"$PLOINKY" --dry-run --port "$ROUTER_PORT" start explorer',
        '"$PLOINKY" start explorer "${BRANCH_ARGS[@]}"',
    ]) {
        assert.ok(workflow.indexOf(entry) > admission, `host entry point must follow workspace admission: ${entry}`);
    }
    assert.doesNotMatch(workflow.slice(end), /^ {10,}(?:cd|pushd|popd)\s/m,
        'later host commands must retain the admitted workspace');
});
