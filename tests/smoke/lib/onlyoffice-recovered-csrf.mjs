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

// Records POST /<route>/mcp and GET /auth/token requests: responses, failed or
// aborted requests, and every document navigation, in one ordered list. Each
// entry carries the frame and document epoch of the request that produced it,
// stamped when the request starts. Only statuses, digests and generation
// identifiers are kept: never a proof value, a response body, or a request body.
export function createMutationTrafficRecorder({ phase, elapsed }) {
  const traffic = [];
  const pending = new Set();
  const pageIds = new WeakMap();
  const frames = new WeakMap();
  const stamps = new WeakMap();
  let nextPageId = 1;
  let nextFrameId = 1;
  let nextSeq = 1;

  function pageIdOf(page) {
    if (!pageIds.has(page)) pageIds.set(page, nextPageId++);
    return pageIds.get(page);
  }

  // A frame is a JavaScript realm with its own proof cache and message ids.
  // Its epoch advances with every document navigation request, so requests
  // from before and after a reload never share one.
  function frameStateOf(request) {
    try {
      const frame = request.frame();
      const page = frame?.page();
      if (!frame || !page) return null;
      if (!frames.has(frame)) {
        frames.set(frame, { id: nextFrameId++, pageId: pageIdOf(page), isMain: page.mainFrame() === frame, epoch: 0 });
      }
      return frames.get(frame);
    } catch {
      return null;
    }
  }

  function stampOf(request) {
    if (!stamps.has(request)) {
      const state = frameStateOf(request);
      stamps.set(request, state
        ? { pageId: state.pageId, frameId: state.id, epoch: state.epoch }
        : { pageId: 0, frameId: 0, epoch: 0 });
    }
    return stamps.get(request);
  }

  function track(entry, work) {
    const promise = work().catch(() => { entry.captureError = true; }).finally(() => pending.delete(promise));
    pending.add(promise);
  }

  function parseUrl(value) {
    try {
      return new URL(value);
    } catch {
      return null;
    }
  }

  function kindOf(method, parsed) {
    if (method === 'POST' && MUTATION_PATH.test(parsed.pathname)) return 'mutation';
    if (method === 'GET' && parsed.pathname === '/auth/token') return 'proof';
    return '';
  }

  function entryFor(request, parsed, kind, outcome, status) {
    const method = request.method();
    const stamp = stampOf(request);
    const common = {
      seq: nextSeq++,
      ...stamp,
      phase: phase(),
      elapsedMs: elapsed(),
      method,
      status,
      url: `${parsed.origin}${parsed.pathname}`,
    };
    if (kind === 'mutation') {
      const text = request.postData() || '';
      return {
        kind: `mutation-${outcome}`,
        ...common,
        bodyHash: digest(text),
        ...jsonRpcSummary(text),
        proofRef: '',
        csrfInvalidBody: null,
      };
    }
    return {
      kind: `proof-${outcome}`,
      ...common,
      mutationRoute: parsed.searchParams.get('mutationRoute') || '',
      routeKey: '',
      origin: '',
      generation: '',
      proofRef: '',
    };
  }

  return Object.freeze({
    traffic,
    // Stamps the request with its frame epoch as it starts. A document
    // navigation request starts a new epoch for that frame.
    onRequest(request) {
      if (request.isNavigationRequest?.()) {
        const state = frameStateOf(request);
        if (state) {
          state.epoch += 1;
          traffic.push({
            kind: 'navigation',
            seq: nextSeq++,
            pageId: state.pageId,
            frameId: state.id,
            isMain: state.isMain,
            epoch: state.epoch,
            phase: phase(),
            elapsedMs: elapsed(),
          });
        }
      }
      stampOf(request);
    },
    onRequestFailed(request) {
      const parsed = parseUrl(request.url());
      const kind = parsed && kindOf(request.method(), parsed);
      if (!kind) return;
      const entry = entryFor(request, parsed, kind, 'failed', 0);
      entry.failure = request.failure()?.errorText || '';
      traffic.push(entry);
    },
    onResponse(response) {
      const request = response.request();
      const parsed = parseUrl(response.url());
      const kind = parsed && kindOf(request.method(), parsed);
      if (!kind) return;
      const status = response.status();
      const entry = entryFor(request, parsed, kind, 'response', status);
      traffic.push(entry);
      if (kind === 'mutation') {
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
      } else if (status === 200) {
        track(entry, async () => {
          const mutation = (await response.json())?.browserMutation;
          entry.routeKey = typeof mutation?.routeKey === 'string' ? mutation.routeKey : '';
          entry.origin = typeof mutation?.origin === 'string' ? mutation.origin : '';
          entry.generation = typeof mutation?.generation === 'string' ? mutation.generation : '';
          entry.proofRef = digest(typeof mutation?.csrfToken === 'string' ? mutation.csrfToken : '');
        });
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

function judge(forbidden, { mutations, proofs, navigations, consoleErrors, forbiddenResponses }) {
  if (forbidden.captureError) return { reason: 'capture-failed' };
  if (forbidden.csrfInvalidBody === null) return { reason: 'forbidden-body-unreadable' };
  if (forbidden.csrfInvalidBody !== true) return { reason: 'forbidden-body-not-browser-csrf-invalid' };
  const route = routeOf(forbidden.url);
  if (!route || !forbidden.bodyHash || !forbidden.proofRef) return { reason: 'operation-not-identifiable' };
  if (!forbidden.pageId || !forbidden.frameId) return { reason: 'frame-not-identifiable' };

  // The same-operation successor is the immediate next attempt, whatever its
  // outcome: a failed or aborted attempt is the retry and ends the recovery.
  const sameOperation = mutations.filter((entry) => entry.pageId === forbidden.pageId
    && entry.url === forbidden.url && entry.method === forbidden.method && entry.bodyHash === forbidden.bodyHash);
  const position = sameOperation.indexOf(forbidden);
  const before = sameOperation[position - 1];
  const retry = sameOperation[position + 1];
  if (before?.status === 403) return { reason: 'repeated-403' };
  if (!retry) return { reason: 'retry-missing' };
  if (retry.kind === 'mutation-failed') return { reason: 'retry-failed' };
  if (retry.status === 403) return { reason: 'repeated-403' };
  if (!isSuccess(retry.status)) return { reason: 'retry-not-2xx' };
  if (retry.captureError || !retry.proofRef) return { reason: 'capture-failed' };

  // Recovery must complete inside the document that was rejected.
  const between = (entry) => entry.seq > forbidden.seq && entry.seq < retry.seq;
  if (navigations.some((entry) => between(entry) && entry.pageId === forbidden.pageId
    && (entry.isMain || entry.frameId === forbidden.frameId))) return { reason: 'navigation-during-recovery' };
  if (proofs.some((entry) => between(entry) && entry.kind === 'proof-failed' && entry.mutationRoute === route)) {
    return { reason: 'proof-request-failed-during-recovery' };
  }
  const sameDocument = (entry) => entry.pageId === forbidden.pageId && entry.frameId === forbidden.frameId
    && entry.epoch === forbidden.epoch;
  if (!sameDocument(retry)) return { reason: 'retry-in-different-document' };

  const rejected = proofs.filter((entry) => entry.seq < forbidden.seq && entry.status === 200
    && entry.routeKey === route && entry.proofRef === forbidden.proofRef && entry.generation).at(-1);
  if (!rejected) return { reason: 'rejected-proof-generation-unobserved' };

  const refresh = proofs.find((entry) => entry.seq > forbidden.seq && entry.pageId === forbidden.pageId
    && entry.mutationRoute === route);
  if (!refresh || refresh.seq > retry.seq) return { reason: 'refresh-missing' };
  if (refresh.status !== 200) return { reason: 'refresh-failed' };
  if (!sameDocument(refresh)) return { reason: 'refresh-in-different-document' };
  if (refresh.captureError || refresh.routeKey !== route || !refresh.generation || !refresh.proofRef
    || refresh.origin !== originOf(forbidden.url)) return { reason: 'refresh-unreadable-or-mismatched' };
  if (refresh.generation === rejected.generation) return { reason: 'generation-unchanged' };
  if (retry.proofRef !== refresh.proofRef) return { reason: 'retry-did-not-use-refreshed-proof' };

  const window = [forbidden.elapsedMs - CONSOLE_LEAD_TOLERANCE_MS, retry.elapsedMs];
  const consoles = exactConsoleCandidates(consoleErrors, forbidden.url)
    .filter((event) => event.elapsedMs >= window[0] && event.elapsedMs <= window[1]);
  if (consoles.length !== 1) return { reason: `console-error-count-${consoles.length}` };
  // Per-URL closure: every 403 at this URL has exactly one console error, so a
  // recovery whose own console error is missing cannot claim another event.
  const urlConsoles = exactConsoleCandidates(consoleErrors, forbidden.url).length;
  const urlForbidden = forbiddenResponses.filter((entry) => entry.url === forbidden.url).length;
  if (urlConsoles !== urlForbidden) return { reason: `console-403-count-mismatch-${urlConsoles}-${urlForbidden}` };

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
export function evaluateRecoveredCsrfRefreshes({
  traffic = [],
  consoleErrors = [],
  // Every 403 response seen for any request (the gate's response events).
  // Defaults to the recorded mutation 403s for pure callers.
  forbiddenResponses = traffic.filter((entry) => entry.kind === 'mutation-response' && entry.status === 403),
} = {}) {
  const ordered = [...traffic].sort((left, right) => left.seq - right.seq);
  const mutations = ordered.filter((entry) => entry.kind === 'mutation-response' || entry.kind === 'mutation-failed');
  const proofs = ordered.filter((entry) => entry.kind === 'proof-response' || entry.kind === 'proof-failed');
  const navigations = ordered.filter((entry) => entry.kind === 'navigation');
  const claims = new Map();
  const outcomes = [];
  for (const forbidden of mutations.filter((entry) => entry.kind === 'mutation-response' && entry.status === 403)) {
    const outcome = judge(forbidden, { mutations, proofs, navigations, consoleErrors, forbiddenResponses });
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
