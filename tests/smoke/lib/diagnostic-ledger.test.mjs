import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDiagnosticLedger,
  diagnosticEventSignature,
} from './diagnostic-ledger.mjs';

const STREAM_URL = 'http://127.0.0.1:8080/webtty/sessions/session-proof-12345678901234567890/stream';

function recoveryEvents() {
  return [
    {
      kind: 'requestfailed',
      type: 'error',
      url: STREAM_URL,
      method: 'GET',
      failure: 'net::ERR_INCOMPLETE_CHUNKED_ENCODING',
    },
    {
      kind: 'console',
      type: 'error',
      text: 'Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING',
      location: { url: STREAM_URL, lineNumber: 0, columnNumber: 0 },
    },
    {
      kind: 'response',
      type: 'error',
      status: 404,
      url: STREAM_URL,
      method: 'GET',
    },
    {
      kind: 'console',
      type: 'error',
      text: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
      location: { url: STREAM_URL, lineNumber: 0, columnNumber: 0 },
    },
  ];
}

const expectedRecovery = recoveryEvents().map(diagnosticEventSignature);

test('exact diagnostics are acknowledged but retained in the evidence array', () => {
  const events = [{ kind: 'console', type: 'log', text: 'ordinary evidence', location: {} }];
  const ledger = createDiagnosticLedger(events, { isActionable: (event) => event.type === 'error' });
  const checkpoint = ledger.checkpoint('exact Router recovery');
  events.push(...recoveryEvents());

  assert.deepEqual(ledger.acknowledgeExact(checkpoint, expectedRecovery), expectedRecovery);
  assert.deepEqual(ledger.actionableEvents(), []);
  assert.equal(events.length, 5);
  assert.doesNotThrow(() => ledger.assertNoOpenCheckpoints());
});

for (const [name, mutate] of [
  ['other session', (events) => { events[0].url = `${STREAM_URL}-other`; }],
  ['wrong method', (events) => { events[2].method = 'POST'; }],
  ['wrong status', (events) => { events[2].status = 500; }],
  ['wrong transport failure', (events) => { events[0].failure = 'net::ERR_FAILED'; }],
  ['generic console error', (events) => { events[1].text = 'unexpected browser failure'; }],
]) {
  test(`diagnostic acknowledgement rejects ${name}`, () => {
    const events = [];
    const ledger = createDiagnosticLedger(events);
    const checkpoint = ledger.checkpoint(name);
    const observed = recoveryEvents();
    mutate(observed);
    events.push(...observed);

    assert.throws(() => ledger.acknowledgeExact(checkpoint, expectedRecovery), /unexpected diagnostic event multiset/);
    assert.equal(ledger.actionableEvents().length, 4);
    assert.throws(() => ledger.assertNoOpenCheckpoints(), new RegExp(name));
  });
}

test('diagnostic acknowledgement rejects missing and duplicate events', () => {
  for (const observed of [recoveryEvents().slice(0, -1), [...recoveryEvents(), recoveryEvents()[0]]]) {
    const events = [];
    const ledger = createDiagnosticLedger(events);
    const checkpoint = ledger.checkpoint('exact count');
    events.push(...observed);
    assert.throws(() => ledger.acknowledgeExact(checkpoint, expectedRecovery), /unexpected diagnostic event multiset/);
    assert.equal(ledger.actionableEvents().length, observed.length);
  }
});

test('diagnostic acknowledgement rejects an extra page error', () => {
  const events = [];
  const ledger = createDiagnosticLedger(events);
  const checkpoint = ledger.checkpoint('extra page error');
  events.push(...recoveryEvents(), {
    kind: 'pageerror',
    type: 'error',
    text: 'unexpected application exception',
  });
  assert.throws(() => ledger.acknowledgeExact(checkpoint, expectedRecovery), /unexpected diagnostic event multiset/);
  assert.equal(ledger.actionableEvents().length, 5);
});

test('unconsumed checkpoints fail closed', () => {
  const ledger = createDiagnosticLedger([]);
  ledger.checkpoint('forgotten negative probe');
  assert.throws(() => ledger.assertNoOpenCheckpoints(), /forgotten negative probe/);
});

test('closing a checkpoint without acknowledgement consumes only it and leaves every event actionable', () => {
  const events = [];
  const ledger = createDiagnosticLedger(events, { isActionable: (event) => event.type === 'error' });
  const outer = ledger.checkpoint('outer operation');
  const inner = ledger.checkpoint('authentication navigation');
  events.push(...recoveryEvents());
  assert.equal(ledger.closeWithoutAcknowledgement(inner), undefined, 'closure returns no acknowledgement');
  assert.equal(ledger.actionableEvents().length, 4);
  assert.equal(events.length, 4, 'closure removes no evidence');
  assert.throws(() => ledger.closeWithoutAcknowledgement(inner), /unknown or already consumed/);
  assert.throws(() => ledger.acknowledgeExact(inner, expectedRecovery), /unknown or already consumed/);
  assert.throws(() => ledger.assertExact(inner, expectedRecovery), /unknown or already consumed/);
  assert.throws(() => ledger.assertNoOpenCheckpoints(), /outer operation/);
  assert.deepEqual(ledger.acknowledgeExact(outer, expectedRecovery), expectedRecovery, 'another checkpoint is unaffected');
  assert.doesNotThrow(() => ledger.assertNoOpenCheckpoints());
});

test('a checkpoint of another ledger or an acknowledged one cannot be closed', () => {
  const first = createDiagnosticLedger([]);
  const second = createDiagnosticLedger([]);
  const token = first.checkpoint('owned elsewhere');
  assert.throws(() => second.closeWithoutAcknowledgement(token), /unknown or already consumed/);
  assert.throws(() => second.closeWithoutAcknowledgement({ label: 'owned elsewhere', start: 0 }), /unknown or already consumed/);
  first.acknowledgeExact(token, []);
  assert.throws(() => first.closeWithoutAcknowledgement(token), /unknown or already consumed/);
});
