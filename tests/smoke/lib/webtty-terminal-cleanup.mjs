export function requireDetachedShell(payload, id) {
  if (payload?.ok !== true || payload?.version !== 1 || !Array.isArray(payload.sessions)) {
    throw new Error('Invalid Live Sessions list in the tab-close probe.');
  }
  const row = payload.sessions.find((candidate) => candidate.id === id);
  if (!row || row.status !== 'detached' || row.viewerCount !== 0) {
    throw new Error('The same shell must remain detached with no viewers after tab close.');
  }
  return row;
}

export async function cleanupWebttyTerminals({ terminals, authenticate, closeTerminal, closeContexts, removeFixture, priorFailure }) {
  const failures = [];
  const pending = [...terminals].reverse().filter((terminal) => !terminal.cleaned);
  let requestPage;
  if (pending.length) {
    try {
      // Keep the authenticated page/context alive until every DELETE has settled.
      requestPage = await authenticate();
    } catch (error) {
      failures.push(error);
    }
    if (requestPage) {
      for (const terminal of pending) {
        try {
          await closeTerminal(terminal, { requestPage, allowMissing: true });
          if (!terminal.cleaned) throw new Error('Terminal cleanup was not confirmed.');
        } catch (error) {
          failures.push(error);
        }
      }
    } else if (!failures.length) {
      failures.push(new Error('No authenticated terminal cleanup page was returned.'));
    }
  }
  try {
    await closeContexts();
  } catch (error) {
    failures.push(error);
  }
  if (!failures.length && terminals.every((terminal) => terminal.cleaned)) {
    try {
      await removeFixture();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(priorFailure ? [priorFailure, ...failures] : failures,
      'WebTTY cleanup failed; the fixture is retained until terminal cleanup is confirmed.');
  }
}
