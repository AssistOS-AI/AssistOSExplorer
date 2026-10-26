import { isDeepStrictEqual } from 'node:util';

function sameExactMultiset(left, right) {
  const canonical = (entries) => entries.map((entry) => JSON.stringify(entry)).sort();
  return isDeepStrictEqual(canonical(left), canonical(right));
}

export function diagnosticEventSignature(event) {
  const shared = {
    kind: String(event?.kind || ''),
    type: String(event?.type || ''),
  };
  if (event?.kind === 'requestfailed') {
    return {
      ...shared,
      url: String(event.url || ''),
      method: String(event.method || ''),
      failure: String(event.failure || ''),
    };
  }
  if (event?.kind === 'response') {
    return {
      ...shared,
      status: Number(event.status),
      url: String(event.url || ''),
      method: String(event.method || ''),
    };
  }
  if (event?.kind === 'console') {
    return {
      ...shared,
      text: String(event.text || ''),
      locationUrl: String(event.location?.url || ''),
    };
  }
  if (event?.kind === 'pageerror') {
    return {
      ...shared,
      text: String(event.text || ''),
    };
  }
  return shared;
}

export function createDiagnosticLedger(events, { isActionable = () => true } = {}) {
  if (!Array.isArray(events)) throw new TypeError('diagnostic events must be an array');
  if (typeof isActionable !== 'function') throw new TypeError('isActionable must be a function');
  const acknowledged = new Set();
  const checkpoints = new Set();

  function actionableEvents() {
    return events.filter((event) => isActionable(event) && !acknowledged.has(event));
  }

  function checkpoint(label = 'diagnostic operation') {
    const token = {
      label: String(label || 'diagnostic operation'),
      start: events.length,
    };
    checkpoints.add(token);
    return token;
  }

  function acknowledgeExact(token, expectedSignatures) {
    if (!checkpoints.has(token)) {
      throw new Error('diagnostic checkpoint is unknown or already consumed');
    }
    if (!Array.isArray(expectedSignatures)) {
      throw new TypeError('expected diagnostic signatures must be an array');
    }
    const candidates = events
      .slice(token.start)
      .filter((event) => isActionable(event) && !acknowledged.has(event));
    const observed = candidates.map(diagnosticEventSignature);
    if (!sameExactMultiset(observed, expectedSignatures)) {
      throw new Error(
        `${token.label} produced an unexpected diagnostic event multiset\n`
        + `expected: ${JSON.stringify(expectedSignatures)}\n`
        + `observed: ${JSON.stringify(observed)}`,
      );
    }
    for (const event of candidates) acknowledged.add(event);
    checkpoints.delete(token);
    return observed;
  }

  function assertExact(token, expectedSignatures) {
    if (!checkpoints.has(token)) {
      throw new Error('diagnostic checkpoint is unknown or already consumed');
    }
    if (!Array.isArray(expectedSignatures)) {
      throw new TypeError('expected diagnostic signatures must be an array');
    }
    const observed = events
      .slice(token.start)
      .filter((event) => isActionable(event) && !acknowledged.has(event))
      .map(diagnosticEventSignature);
    if (!sameExactMultiset(observed, expectedSignatures)) {
      throw new Error(
        `${token.label} produced an unexpected diagnostic event multiset\n`
        + `expected: ${JSON.stringify(expectedSignatures)}\n`
        + `observed: ${JSON.stringify(observed)}`,
      );
    }
    return observed;
  }

  // Consumes one open checkpoint without acknowledging anything: every event
  // it covered stays actionable. An unknown or consumed checkpoint throws.
  function closeWithoutAcknowledgement(token) {
    if (!checkpoints.has(token)) {
      throw new Error('diagnostic checkpoint is unknown or already consumed');
    }
    checkpoints.delete(token);
  }

  function assertNoOpenCheckpoints() {
    if (checkpoints.size === 0) return;
    throw new Error(
      `unconsumed diagnostic checkpoints: ${[...checkpoints].map((token) => token.label).join(', ')}`,
    );
  }

  return Object.freeze({
    acknowledgeExact,
    actionableEvents,
    assertNoOpenCheckpoints,
    assertExact,
    checkpoint,
    closeWithoutAcknowledgement,
  });
}
