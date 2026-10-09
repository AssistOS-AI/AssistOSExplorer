import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

// Bounded exception for one pre-existing, self-healing browser behaviour.
//
// A targeted OnlyOffice restart changes the workspace-wide edge generation.
// The browser mutation proof is bound to that generation, so the first MCP
// mutation after a restart is answered 403 {"error":"browser_csrf_invalid"}.
// The page's MCP client (ploinky Agent/client/MCPBrowserClient.js
// sendMutationRequest) then refreshes its proof with
// GET /auth/token?mutationRoute=<route> and retries the identical POST once.
// Chromium logs the rejected attempt as a console error even though the
// operation recovers. Only that exact, fully evidenced recovery is
// acknowledged. Anything else stays a browser error.

const CSRF_HEADER = 'x-ploinky-browser-csrf-token';
const CSRF_ERROR_BODY = Object.freeze({ error: 'browser_csrf_invalid' });
export const RECOVERED_CSRF_CONSOLE_TEXT = 'Failed to load resource: the server responded with a status of 403 (Forbidden)';
// The console message and the response event come from different Chromium
// processes; the observed ordering is response first at the same millisecond.
// A console message up to this long before the 403 response event still
// belongs to it. It must also be the only matching message for the URL.
export const CONSOLE_LEAD_TOLERANCE_MS = 100;

const MUTATION_PATH = /^\/([^/]+)\/mcp$/;

function digest(value) {
  return value ? createHash('sha256').update(String(value)).digest('hex').slice(0, 12) : '';
}

function routeOf(url) {
  try {
    return MUTATION_PATH.exec(new URL(url).pathname)?.[1] || '';
  } catch {
    return '';
  }
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function jsonRpcSummary(text) {
  try {
    const parsed = JSON.parse(text);
    const message = Array.isArray(parsed) ? null : parsed;
    return {
      rpcMethod: typeof message?.method === 'string' ? message.method : '',
      rpcId: message?.id === undefined || message.id === null ? '' : String(message.id),
    };
  } catch {
    return { rpcMethod: '', rpcId: '' };
  }
}

// Records POST /<route>/mcp responses and GET /auth/token proof responses.
// Only statuses, digests and generation identifiers are kept: never a proof
// value, a response body, or a request body.
export function createMutationTrafficRecorder({ phase, elapsed }) {
  const traffic = [];
  const pending = new Set();
  const pageIds = new WeakMap();
  let nextPageId = 1;
  let nextSeq = 1;

  function pageIdOf(request) {
    try {
      const page = request.frame()?.page();
      if (!page) return 0;
      if (!pageIds.has(page)) pageIds.set(page, nextPageId++);
      return pageIds.get(page);
    } catch {
      return 0;
    }
  }

  function track(entry, work) {
    const promise = work().catch(() => { entry.captureError = true; }).finally(() => pending.delete(promise));
    pending.add(promise);
  }

  return Object.freeze({
    traffic,
    onResponse(response) {
      const request = response.request();
      const url = response.url();
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      const method = request.method();
      const status = response.status();
      const base = () => ({
        seq: nextSeq++,
        pageId: pageIdOf(request),
        phase: phase(),
        elapsedMs: elapsed(),
        method,
        status,
      });
      if (method === 'POST' && MUTATION_PATH.test(parsed.pathname)) {
        const text = request.postData() || '';
        const entry = {
          kind: 'mutation-response',
          ...base(),
          url: `${parsed.origin}${parsed.pathname}`,
          bodyHash: digest(text),
          ...jsonRpcSummary(text),
          proofRef: '',
          csrfInvalidBody: null,
        };
        traffic.push(entry);
        track(entry, async () => {
          entry.proofRef = digest(await request.headerValue(CSRF_HEADER));
          if (status === 403) {
            try {
              entry.csrfInvalidBody = isDeepStrictEqual(JSON.parse(await response.text()), CSRF_ERROR_BODY);
            } catch {
              entry.csrfInvalidBody = null;
            }
          }
        });
      } else if (method === 'GET' && parsed.pathname === '/auth/token') {
        const entry = {
          kind: 'proof-response',
          ...base(),
          url: `${parsed.origin}${parsed.pathname}`,
          mutationRoute: parsed.searchParams.get('mutationRoute') || '',
          routeKey: '',
          origin: '',
          generation: '',
          proofRef: '',
        };
        traffic.push(entry);
        if (status === 200) {
          track(entry, async () => {
            const mutation = (await response.json())?.browserMutation;
            entry.routeKey = typeof mutation?.routeKey === 'string' ? mutation.routeKey : '';
            entry.origin = typeof mutation?.origin === 'string' ? mutation.origin : '';
            entry.generation = typeof mutation?.generation === 'string' ? mutation.generation : '';
            entry.proofRef = digest(typeof mutation?.csrfToken === 'string' ? mutation.csrfToken : '');
          });
        }
      }
    },
    async settle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  });
}

function isSuccess(status) {
  return status >= 200 && status < 300;
}

function exactConsoleCandidates(consoleErrors, url) {
  return consoleErrors.filter((event) => event.type === 'error'
    && event.text === RECOVERED_CSRF_CONSOLE_TEXT
    && event.location?.url === url);
}

function judge(forbidden, { mutations, proofs, consoleErrors }) {
  if (forbidden.captureError) return { reason: 'capture-failed' };
  if (forbidden.csrfInvalidBody === null) return { reason: 'forbidden-body-unreadable' };
  if (forbidden.csrfInvalidBody !== true) return { reason: 'forbidden-body-not-browser-csrf-invalid' };
  const route = routeOf(forbidden.url);
  if (!route || !forbidden.bodyHash || !forbidden.proofRef) return { reason: 'operation-not-identifiable' };

  const sameOperation = mutations.filter((entry) => entry.pageId === forbidden.pageId
    && entry.url === forbidden.url && entry.method === forbidden.method && entry.bodyHash === forbidden.bodyHash);
  const position = sameOperation.indexOf(forbidden);
  const before = sameOperation[position - 1];
  const retry = sameOperation[position + 1];
  if (before?.status === 403) return { reason: 'repeated-403' };
  if (!retry) return { reason: 'retry-missing' };
  if (retry.status === 403) return { reason: 'repeated-403' };
  if (!isSuccess(retry.status)) return { reason: 'retry-not-2xx' };
  if (retry.captureError || !retry.proofRef) return { reason: 'capture-failed' };

  const rejected = proofs.filter((entry) => entry.seq < forbidden.seq && entry.status === 200
    && entry.routeKey === route && entry.proofRef === forbidden.proofRef && entry.generation).at(-1);
  if (!rejected) return { reason: 'rejected-proof-generation-unobserved' };

  const refresh = proofs.find((entry) => entry.seq > forbidden.seq && entry.pageId === forbidden.pageId
    && entry.mutationRoute === route);
  if (!refresh || refresh.seq > retry.seq) return { reason: 'refresh-missing' };
  if (refresh.status !== 200) return { reason: 'refresh-failed' };
  if (refresh.captureError || refresh.routeKey !== route || !refresh.generation || !refresh.proofRef
    || refresh.origin !== originOf(forbidden.url)) return { reason: 'refresh-unreadable-or-mismatched' };
  if (refresh.generation === rejected.generation) return { reason: 'generation-unchanged' };
  if (retry.proofRef !== refresh.proofRef) return { reason: 'retry-did-not-use-refreshed-proof' };

  const window = [forbidden.elapsedMs - CONSOLE_LEAD_TOLERANCE_MS, retry.elapsedMs];
  const consoles = exactConsoleCandidates(consoleErrors, forbidden.url)
    .filter((event) => event.elapsedMs >= window[0] && event.elapsedMs <= window[1]);
  if (consoles.length !== 1) return { reason: `console-error-count-${consoles.length}` };

  return {
    console: consoles[0],
    acknowledgement: {
      phase: forbidden.phase,
      url: forbidden.url,
      method: forbidden.method,
      rpcMethod: forbidden.rpcMethod,
      rpcId: forbidden.rpcId,
      bodyHash: forbidden.bodyHash,
      forbiddenStatus: forbidden.status,
      forbiddenBody: CSRF_ERROR_BODY.error,
      rejectedGeneration: rejected.generation,
      refreshedGeneration: refresh.generation,
      refreshStatus: refresh.status,
      retryStatus: retry.status,
      forbiddenAtMs: forbidden.elapsedMs,
      refreshAtMs: refresh.elapsedMs,
      retryAtMs: retry.elapsedMs,
      refreshLatencyMs: refresh.elapsedMs - forbidden.elapsedMs,
      retryLatencyMs: retry.elapsedMs - forbidden.elapsedMs,
      consoleText: consoles[0].text,
      consoleAtMs: consoles[0].elapsedMs,
    },
  };
}

// Pure decision over recorded evidence. Every 403 POST /<route>/mcp is judged
// independently; a console error is acknowledged only when exactly one fully
// proven recovery claims it. `unacknowledgedConsoleErrors` is what still fails
// the gate; `rejected` explains each 403 that could not be acknowledged.
export function evaluateRecoveredCsrfRefreshes({ traffic = [], consoleErrors = [] } = {}) {
  const ordered = [...traffic].sort((left, right) => left.seq - right.seq);
  const mutations = ordered.filter((entry) => entry.kind === 'mutation-response');
  const proofs = ordered.filter((entry) => entry.kind === 'proof-response');
  const claims = new Map();
  const outcomes = [];
  for (const forbidden of mutations.filter((entry) => entry.status === 403)) {
    const outcome = judge(forbidden, { mutations, proofs, consoleErrors });
    outcomes.push({ forbidden, outcome });
    if (outcome.console) claims.set(outcome.console, [...(claims.get(outcome.console) || []), outcome]);
  }
  const acknowledged = [];
  const rejected = [];
  const acknowledgedConsoles = new Set();
  for (const { forbidden, outcome } of outcomes) {
    // One console message can never account for two operations.
    const ambiguous = outcome.console && claims.get(outcome.console).length !== 1;
    if (outcome.acknowledgement && !ambiguous) {
      acknowledged.push(outcome.acknowledgement);
      acknowledgedConsoles.add(outcome.console);
    } else {
      rejected.push({
        phase: forbidden.phase,
        url: forbidden.url,
        rpcMethod: forbidden.rpcMethod,
        rpcId: forbidden.rpcId,
        reason: ambiguous ? 'console-error-claimed-by-multiple-operations' : outcome.reason,
      });
    }
  }
  return {
    acknowledged,
    rejected,
    unacknowledgedConsoleErrors: consoleErrors.filter((event) => !acknowledgedConsoles.has(event)),
  };
}
