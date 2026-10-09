import assert from 'node:assert/strict';
import test from 'node:test';

import path from 'node:path';

import { smokeConfig } from './config.mjs';
import { dpuData, resolveDpuBoxEndpoint, resolveDpuBoxPaths } from './dpu-data.mjs';

test('DPU smoke fixtures use the canonical .data roots', () => {
  if (!process.env.SMOKE_DPU_DATA_ROOT) {
    assert.equal(
      smokeConfig.dpuDataRoot,
      path.join(smokeConfig.workspaceRoot || smokeConfig.repoRoot, '.data', 'dpu-data'),
    );
  }
});

test('DPU Box paths derive from the inspected same-path workspace and match the selected host fixture', () => {
  const workspaceRoot = '/home/operator/work space ăîș';
  const inspected = {
    Config: { WorkingDir: workspaceRoot, Env: [`PLOINKY_WORKSPACE_ROOT=${workspaceRoot}`] },
    Mounts: [{ Type: 'bind', Source: workspaceRoot, Destination: workspaceRoot, RW: true }],
  };
  const options = { workspaceRoot, realpathSync: (value) => value };
  assert.deepEqual(resolveDpuBoxPaths(inspected, options), {
    workspaceRoot, dataRoot: `${workspaceRoot}/.data/dpu-data`,
  });
  assert.throws(() => resolveDpuBoxPaths(inspected, { ...options, workspaceRoot: '' }), /SMOKE_WORKSPACE_ROOT is required/);
  assert.throws(() => resolveDpuBoxPaths(inspected, { ...options, workspaceRoot: '/other/workspace' }), /does not equal/);
  for (const mutate of [
    (value) => { value.Config.Env = ['PLOINKY_WORKSPACE_ROOT=/other/workspace']; },
    (value) => { value.Config.Env.push(`PLOINKY_WORKSPACE_ROOT=${workspaceRoot}`); },
    (value) => { value.Mounts[0].Destination = '/workspace'; },
    (value) => { value.Mounts[0].Source = '/other/workspace'; },
    (value) => { value.Mounts[0].RW = false; },
  ]) {
    const altered = structuredClone(inspected);
    mutate(altered);
    assert.throws(() => resolveDpuBoxPaths(altered, options));
  }
});

test('DPU evidence paths reject parent traversal before filesystem normalization', () => {
  for (const segments of [
    ['..', 'state.json'],
    ['nested/../../state.json'],
    ['nested\\..\\..\\state.json'],
  ]) {
    assert.throws(
      () => dpuData.exists(...segments),
      /parent traversal segment/,
      segments.join('/'),
    );
  }
});

test('DPU Box evidence requires a separate exact loopback authority', () => {
  assert.throws(
    () => resolveDpuBoxEndpoint({ deploymentMode: 'box', boxBaseURL: '' }),
    /requires an explicit loopback SMOKE_BOX_BASE_URL/,
  );
  assert.throws(
    () => resolveDpuBoxEndpoint({
      deploymentMode: 'box',
      boxBaseURL: 'https://explorer-qa.axiologic.dev',
    }),
    /SMOKE_BOX_BASE_URL must be an exact credential-free http:\/\/127\.0\.0\.1/,
  );
  assert.deepEqual(
    resolveDpuBoxEndpoint({
      deploymentMode: 'box',
      boxBaseURL: 'http://127.0.0.1:8097',
    }),
    { baseURL: 'http://127.0.0.1:8097', port: '8097' },
  );
});

test('DPU Box evidence accepts the canonical localhost authority only for the 127.0.0.1 Router publication', () => {
  assert.deepEqual(
    resolveDpuBoxEndpoint({ deploymentMode: 'box', boxBaseURL: 'http://localhost:8080', expectedRouterBindAddress: '127.0.0.1' }),
    { baseURL: 'http://localhost:8080', port: '8080' },
  );
  for (const address of ['0.0.0.0', '192.168.1.50']) {
    assert.throws(
      () => resolveDpuBoxEndpoint({ deploymentMode: 'box', boxBaseURL: 'http://localhost:8080', expectedRouterBindAddress: address }),
      /localhost Box origin requires/,
    );
  }
  assert.deepEqual(
    resolveDpuBoxEndpoint({ deploymentMode: 'box', boxBaseURL: 'http://127.0.0.1:8080', expectedRouterBindAddress: '0.0.0.0' }),
    { baseURL: 'http://127.0.0.1:8080', port: '8080' },
  );
  for (const boxBaseURL of ['https://localhost:8080', 'http://localhost:8080/path', 'http://user@localhost:8080', 'http://0.0.0.0:8080', 'http://[::1]:8080']) {
    assert.throws(
      () => resolveDpuBoxEndpoint({ deploymentMode: 'box', boxBaseURL, expectedRouterBindAddress: '127.0.0.1' }),
      /SMOKE_BOX_BASE_URL must be an exact credential-free/,
    );
  }
});
