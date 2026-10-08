import path from 'node:path';
import { pathToFileURL } from 'node:url';

let runtimePromise = null;

async function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const runtimeRoot = String(process.env.PLOINKY_AGENT_RUNTIME_ROOT || '/Agent').trim();
      const [
        { verifyRouterRequestFromHeaders },
        { computeRchTool },
        { createMemoryReplayCache },
        { authInfoFromInvocation }
      ] = await Promise.all([
        import(pathToFileURL(path.join(runtimeRoot, 'lib/invocationAuth.mjs')).href),
        import(pathToFileURL(path.join(runtimeRoot, 'lib/requestHash.mjs')).href),
        import(pathToFileURL(path.join(runtimeRoot, 'lib/jwtVerify.mjs')).href),
        import(pathToFileURL(path.join(runtimeRoot, 'lib/invocation-auth.mjs')).href)
      ]);
      return {
        verifyRouterRequestFromHeaders,
        computeRchTool,
        authInfoFromInvocation,
        replayCache: createMemoryReplayCache({ maxSize: 4096 })
      };
    })();
  }
  return runtimePromise;
}

export async function verifyWebchatInvocation({
  invocationToken = '',
  message = '',
  attachments = [],
  references = [],
  presentation = { visible: true },
  sourceTabId = '',
  sourcePageInstanceId = ''
} = {}) {
  const token = String(invocationToken || '').trim();
  if (!token) throw new Error('Authenticated WebChat invocation is required.');
  const runtime = await loadRuntime();
  const args = {
    surface: 'webchat',
    tabId: String(sourceTabId || ''),
    pageInstanceId: String(sourcePageInstanceId || ''),
    text: String(message || ''),
    attachments: Array.isArray(attachments) ? attachments : [],
    references: Array.isArray(references) ? references : [],
    presentation: { visible: presentation?.visible !== false },
    // DPU WebChat requires a per-user router runtime. A router that does not
    // sign this field (one without principal-scoped runtimes) fails here.
    runtimeScope: 'principal'
  };
  const rch = runtime.computeRchTool({
    method: 'POST',
    path: '/mcp',
    tool: '__webchat_message__',
    arguments: args
  });
  const verified = runtime.verifyRouterRequestFromHeaders(
    { authorization: `Bearer ${token}` },
    {
      env: process.env,
      replayCache: runtime.replayCache,
      method: 'POST',
      path: '/mcp',
      tool: '__webchat_message__',
      rch
    }
  );
  if (!verified.ok) throw new Error('WebChat invocation verification failed.');
  return runtime.authInfoFromInvocation(verified.payload, { invocationToken: verified.rawToken });
}
