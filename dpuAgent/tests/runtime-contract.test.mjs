import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { authInfoFromInvocation } from '../../shared/invocation-auth.mjs';
import { getDpuDataRoot } from '../lib/dpu-store-internal/storage.mjs';

const agentRoot = path.resolve(new URL('..', import.meta.url).pathname);

test('DPU storage fails closed when DPU_DATA_ROOT is absent', () => {
  const previous = process.env.DPU_DATA_ROOT;
  try {
    delete process.env.DPU_DATA_ROOT;
    assert.throws(() => getDpuDataRoot(), /DPU_DATA_ROOT is required/);
    process.env.DPU_DATA_ROOT = '/dpu-data';
    assert.equal(getDpuDataRoot(), '/dpu-data');
  } finally {
    if (previous === undefined) delete process.env.DPU_DATA_ROOT;
    else process.env.DPU_DATA_ROOT = previous;
  }
});

test('package metadata does not expose the retired standalone MCP server', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(agentRoot, 'package.json'), 'utf8'));
  const serializedPackage = JSON.stringify(packageJson);

  assert.equal(fs.existsSync(path.join(agentRoot, 'server', 'standalone-mcp-server.mjs')), false);
  assert.equal(Object.prototype.hasOwnProperty.call(packageJson, 'bin'), false);
  assert.notEqual(packageJson.scripts?.start, 'node ./server/standalone-mcp-server.mjs');
  assert.equal(serializedPackage.includes('standalone-mcp-server'), false);
  assert.equal(serializedPackage.includes('mcp-sdk'), false);
});

test('legacy x-ploinky-caller-jwt does not create delegated user identity', () => {
  const authInfoWithoutUsr = authInfoFromInvocation({
    typ: 'router-request',
    iss: 'ploinky-router',
    aud: 'agent:AssistOSExplorer/dpuAgent',
    sub: 'agent:OnlyOfficeAgent/onlyOffice',
    actor: {
      kind: 'agent',
      id: 'agent:OnlyOfficeAgent/onlyOffice',
      roles: ['agent']
    },
    caller: {
      kind: 'agent',
      id: 'agent:OnlyOfficeAgent/onlyOffice',
      roles: ['agent']
    },
    headers: {
      'x-ploinky-caller-jwt': 'spoofed-delegated-user'
    },
    tool: 'dpu_confidential_get'
  }, {
    invocationToken: 'verified-router-request'
  });

  assert.equal(authInfoWithoutUsr.user, undefined);
  assert.equal(authInfoWithoutUsr.agent?.principalId, 'agent:OnlyOfficeAgent/onlyOffice');
  assert.deepEqual(authInfoWithoutUsr.invocation?.caller, {
    kind: 'agent',
    id: 'agent:OnlyOfficeAgent/onlyOffice',
    roles: ['agent']
  });

  const authInfoWithUsr = authInfoFromInvocation({
    typ: 'router-request',
    iss: 'ploinky-router',
    aud: 'agent:AssistOSExplorer/dpuAgent',
    sub: 'agent:OnlyOfficeAgent/onlyOffice',
    actor: {
      kind: 'agent',
      id: 'agent:OnlyOfficeAgent/onlyOffice',
      roles: ['agent']
    },
    caller: {
      kind: 'agent',
      id: 'agent:OnlyOfficeAgent/onlyOffice',
      roles: ['agent']
    },
    headers: {
      'x-ploinky-caller-jwt': 'spoofed-delegated-user'
    },
    usr: {
      id: 'local:alice',
      username: 'alice',
      roles: ['user']
    },
    tool: 'dpu_confidential_get'
  }, {
    invocationToken: 'verified-router-request'
  });

  assert.equal(authInfoWithUsr.user?.id, 'local:alice');
  assert.equal(authInfoWithUsr.user?.username, 'alice');
  assert.deepEqual(authInfoWithUsr.user?.roles, ['user']);
  assert.equal(authInfoWithUsr.agent?.principalId, 'agent:OnlyOfficeAgent/onlyOffice');
});
