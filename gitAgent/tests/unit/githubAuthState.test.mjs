import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { withGitAgentRuntime as withEnv } from '../helpers/generatedRouterRuntime.mjs';

const agentLibDir = path.resolve(new URL('../../../../ploinky/Agent', import.meta.url).pathname);
const moduleUrl = new URL('../../lib/github-auth.mjs', import.meta.url);
const moduleSuffix = `?test=${Date.now()}`;
const {
  getGithubAuthStateFilePath,
  storeManualGitAuthToken
} = await import(`${moduleUrl.href}${moduleSuffix}`);

function createDpuStubServer(requests) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      requests.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body?.id || null,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: true })
            }
          ]
        }
      }));
    });
  });
}

test('GitHub auth state paths use only the canonical user-scoped .data root', () => {
  const workspaceRoot = path.join(os.tmpdir(), 'git-auth-path-contract');
  const adminStatePath = getGithubAuthStateFilePath(workspaceRoot, {
    user: { id: 'local:admin', username: 'admin' }
  });
  const otherStatePath = getGithubAuthStateFilePath(workspaceRoot, {
    user: { id: 'local:other', username: 'other' }
  });

  assert.equal(path.dirname(adminStatePath), path.join(workspaceRoot, '.data', 'agents', 'gitAgent', 'github-auth'));
  assert.equal(path.dirname(otherStatePath), path.join(workspaceRoot, '.data', 'agents', 'gitAgent', 'github-auth'));
  assert.notEqual(adminStatePath, otherStatePath);
  assert.equal(adminStatePath.includes(`${path.sep}.ploinky${path.sep}state${path.sep}`), false);
});

test('manual GitHub token state is isolated by routed workspace user', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'git-auth-state-'));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const requests = [];
  const server = createDpuStubServer(requests);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const adminAuth = {
    invocationToken: 'admin-invocation',
    user: { id: 'local:admin', username: 'admin' },
    delegations: {
      dpuGitSecrets: {
        token: 'admin-user-delegation-jwt',
        targetAgentId: 'agent:AchillesIDE/dpuAgent',
        tools: ['dpu_secret_put', 'dpu_secret_grant'],
        scope: ['secret:write', 'secret:grant']
      }
    }
  };
  const nicoletaAuth = {
    invocationToken: 'nicoleta-invocation',
    user: { id: 'local:nicoleta', username: 'nicoleta' },
    delegations: {
      dpuGitSecrets: {
        token: 'nicoleta-user-delegation-jwt',
        targetAgentId: 'agent:AchillesIDE/dpuAgent',
        tools: ['dpu_secret_put', 'dpu_secret_grant'],
        scope: ['secret:write', 'secret:grant']
      }
    }
  };
  const adminStatePath = getGithubAuthStateFilePath(workspaceRoot, adminAuth);
  const nicoletaStatePath = getGithubAuthStateFilePath(workspaceRoot, nicoletaAuth);
  assert.equal(path.dirname(adminStatePath), path.join(workspaceRoot, '.data', 'agents', 'gitAgent', 'github-auth'));
  assert.equal(path.dirname(nicoletaStatePath), path.join(workspaceRoot, '.data', 'agents', 'gitAgent', 'github-auth'));

  try {
    await withEnv({
      PLOINKY_ROUTER_URL: `http://127.0.0.1:${port}`,
      PLOINKY_AGENT_ID: 'agent:AchillesIDE/gitAgent',
      PLOINKY_AGENT_PRINCIPAL: 'agent:AchillesIDE/gitAgent',
      PLOINKY_AGENT_SECRET: 'a'.repeat(64),
      PLOINKY_AGENT_LIB_DIR: agentLibDir,
      PLOINKY_DPU_ROUTE: 'dpuAgent'
    }, async () => {
      await storeManualGitAuthToken({ workspaceRoot, authInfo: adminAuth, token: 'ghp_admin' });
      await storeManualGitAuthToken({ workspaceRoot, authInfo: nicoletaAuth, token: 'ghp_nicoleta' });
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.notEqual(adminStatePath, nicoletaStatePath);
  const adminState = JSON.parse(await fs.readFile(adminStatePath, 'utf8'));
  const nicoletaState = JSON.parse(await fs.readFile(nicoletaStatePath, 'utf8'));
  assert.equal(adminState.connection.source, 'token');
  assert.equal(nicoletaState.connection.source, 'token');
  assert.equal(adminState.connection.accessToken, '');
  assert.equal(nicoletaState.connection.accessToken, '');
  assert.equal(requests.filter((body) => body?.params?.name === 'dpu_secret_put').length, 2);
  await assert.rejects(fs.access(path.join(workspaceRoot, '.ploinky', 'state')));
});
