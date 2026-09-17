import assert from 'node:assert/strict';
import test from 'node:test';

import { assertBoxWorkspacePath, inspectBoxWorkspace } from './box-workspace.mjs';

function inspected(root) {
  return {
    Config: { WorkingDir: root, Env: [`PLOINKY_WORKSPACE_ROOT=${root}`] },
    Mounts: [{ Type: 'bind', Source: root, Destination: root, RW: true }],
  };
}

test('Box workspace inspection preserves exact admitted host characters and has no fixed alias', () => {
  for (const root of ['/home/user/work space ăîș 文档', "/tmp/project 'quoted' $(command);&[]", '/workspace']) {
    assert.deepEqual(inspectBoxWorkspace(inspected(root)), {
      type: 'bind', source: root, destination: root, readWrite: true,
    });
  }
});

test('Box workspace admission rejects malformed roots before mount interpretation', () => {
  for (const root of [undefined, '', '/', 'relative', '/root/../other', '/root/', '/root//nested', '/root ', '/root\nname', '/root\\name', '/root:name', '/root/\uD800']) {
    assert.throws(() => assertBoxWorkspacePath(root), /clean absolute host path/);
  }
});

test('Box workspace inspection rejects mismatched, ambiguous, read-only, and aliased grants', () => {
  for (const mutate of [
    (value) => { delete value.Config.Env; },
    (value) => { value.Config.Env = []; },
    (value) => { value.Config.Env.push('PLOINKY_WORKSPACE_ROOT=/host/project'); },
    (value) => { value.Config.WorkingDir = '/host/other'; },
    (value) => { value.Mounts = []; },
    (value) => { value.Mounts.push({ ...value.Mounts[0] }); },
    (value) => { value.Mounts.push({ ...value.Mounts[0], Destination: '/workspace' }); },
    (value) => { value.Mounts[0].RW = false; },
    (value) => { value.Mounts[0].Source = '/host/other'; },
    (value) => { value.Mounts[0].Type = 'volume'; },
  ]) {
    const value = inspected('/host/project');
    mutate(value);
    assert.throws(() => inspectBoxWorkspace(value));
  }
});
