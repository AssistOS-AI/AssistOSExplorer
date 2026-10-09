import assert from 'node:assert/strict';
import test from 'node:test';

import {
  discoverPlaywrightInputActionValues,
  findTraceCredentialResidue,
  redactTraceText,
} from './redacted-trace.mjs';
import { collectSecrets, createRedactor } from './security.mjs';

const DYNAMIC_SECRETS = [
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwYXJ0aWNpcGFudCJ9.dynamic-signature',
  'turn-short-lived-credential',
  'guest-session-cookie',
  'router-private-assertion',
  'csrf-dynamic-value',
  'account-password',
  'opaque-session-id',
];

test('diagnostic redaction treats complete CDP endpoint values as sensitive', () => {
  const endpoint = 'wss://browser-a.test/devtools/browser/opaque-id';
  const secrets = collectSecrets({ SMOKE_BROWSER_A_CDP_URL: endpoint });
  assert.deepEqual(secrets, [{ name: 'SMOKE_BROWSER_A_CDP_URL', value: endpoint }]);
  assert.equal(createRedactor(secrets)(`connect failed: ${endpoint}`).includes(endpoint), false);
});

test('trace redaction removes dynamic join, TURN, cookie, assertion, and CSRF credentials', () => {
  const input = [
    JSON.stringify({
      participantToken: DYNAMIC_SECRETS[0],
      rtcConfig: {
        iceServers: [{ username: 'turn-short-lived-user', credential: DYNAMIC_SECRETS[1] }],
      },
      csrfToken: DYNAMIC_SECRETS[4],
      sessionId: DYNAMIC_SECRETS[6],
    }),
    JSON.stringify({
      headers: [
        { name: 'cookie', value: `ploinky_guest=${DYNAMIC_SECRETS[2]}` },
        { name: 'ploinky-agent-assertion', value: DYNAMIC_SECRETS[3] },
        { name: 'ploinky_sso', value: DYNAMIC_SECRETS[6] },
      ],
    }),
    JSON.stringify({
      body: JSON.stringify({ participantToken: DYNAMIC_SECRETS[0], credential: DYNAMIC_SECRETS[1] }),
    }),
    `password=${DYNAMIC_SECRETS[5]}&participantToken=${DYNAMIC_SECRETS[0]}&credential=${DYNAMIC_SECRETS[1]}`,
    // A compact JWT outside a named JSON field must still be removed.
    `websocket-frame:${DYNAMIC_SECRETS[0]}`,
  ].join('\n');

  const redacted = redactTraceText(input);
  for (const value of [...DYNAMIC_SECRETS, 'turn-short-lived-user']) {
    assert.equal(redacted.includes(value), false, value);
  }
  assert.match(redacted, /\[REDACTED:(?:FIELD|HEADER|FORM|JWT)\]/);
});

test('trace redaction removes per-route guest session cookies named as headers', () => {
  const routeCookie = 'per-route-guest-cookie-value';
  const legacyCookie = 'legacy-guest-cookie-value';
  const input = JSON.stringify({
    headers: [
      { name: 'ploinky_guest_ncGyyzpdIxmPjORN_wQfqv', value: routeCookie },
      { name: 'PLOINKY_GUEST_iw2P_FBNZBzQ_b5bTDMOLe', value: routeCookie },
      { name: 'ploinky_guest', value: legacyCookie },
    ],
  });
  const redacted = redactTraceText(input);
  assert.equal(redacted.includes(routeCookie), false);
  assert.equal(redacted.includes(legacyCookie), false);
  assert.match(redacted, /\[REDACTED:HEADER\]/);
});

test('trace redaction handles JSON bodies escaped inside trace records', () => {
  const escaped = String.raw`{"body":"{\"participantToken\":\"dynamic-participant-token\",\"credential\":\"dynamic-turn-secret\",\"username\":\"dynamic-turn-user\"}"}`;
  const redacted = redactTraceText(escaped);
  assert.equal(redacted.includes('dynamic-participant-token'), false);
  assert.equal(redacted.includes('dynamic-turn-secret'), false);
  assert.equal(redacted.includes('dynamic-turn-user'), false);
  assert.match(redacted, /REDACTED:FIELD/);
});

test('trace redaction preserves NDJSON while removing arbitrary cookie objects and compound cookie fields', () => {
  const traceCookie = 'synthetic-guest-cookie-from-real-trace';
  const guestCookie = 'synthetic-compound-guest-cookie';
  const participantToken = 'synthetic-participant-token';
  const csrfToken = 'synthetic-csrf-token';
  const input = [
    JSON.stringify({
      type: 'resource-snapshot',
      snapshot: {
        request: {
          headers: [
            { name: 'x-ploinky-csrf-token', value: csrfToken },
          ],
        },
        response: {
          headers: [
            { name: 'sec-ch-ua', value: '"Chromium";v="148", "Not.A/Brand";v="99"' },
          ],
        },
      },
    }),
    JSON.stringify({
      cookies: [{ name: 'trace_cookie', value: traceCookie }],
      queryString: [{ name: 'participantToken', value: participantToken }],
      body: JSON.stringify({ guestCookie, participantToken }),
      url: `https://box.test/room?participantToken=${participantToken}&safe=visible`,
    }),
  ].join('\n');

  assert.notEqual(findTraceCredentialResidue(input).length, 0);
  const redacted = redactTraceText(input);
  const records = redacted.split('\n').map((line) => JSON.parse(line));

  assert.equal(records.length, 2);
  assert.equal(records[0].snapshot.response.headers[0].value, '"Chromium";v="148", "Not.A/Brand";v="99"');
  assert.equal(records[1].url.includes('safe=visible'), true);
  for (const secret of [traceCookie, guestCookie, participantToken, csrfToken]) {
    assert.equal(redacted.includes(secret), false, secret);
  }
  assert.deepEqual(findTraceCredentialResidue(redacted), []);
});

test('Playwright input-action values propagate across every textual trace member', () => {
  const shortSentinel = 's3cr!';
  const typedSentinel = 't!';
  const actionMember = [
    JSON.stringify({
      type: 'before',
      method: 'fill',
      params: { selector: 'input[name="password"]', strict: true, value: shortSentinel },
    }),
    JSON.stringify({
      type: 'before',
      method: 'type',
      params: { selector: 'input[name="password"]', strict: true, text: typedSentinel },
    }),
  ].join('\n');
  const logMember = JSON.stringify({
    type: 'log',
    message: `  fill("${shortSentinel}") then type("${typedSentinel}")`,
  });
  const frameSnapshotMember = JSON.stringify({
    type: 'frame-snapshot',
    snapshot: {
      html: ['HTML', {}, ['INPUT', { type: 'password', value: shortSentinel }], typedSentinel],
    },
  });

  const discovered = discoverPlaywrightInputActionValues(actionMember);
  assert.deepEqual([...discovered].sort(), [shortSentinel, typedSentinel].sort());
  assert.notDeepEqual(findTraceCredentialResidue(actionMember), []);

  const redactedMembers = [actionMember, logMember, frameSnapshotMember]
    .map((member) => redactTraceText(member, { inputActionValues: discovered }));
  for (const member of redactedMembers) {
    assert.doesNotThrow(() => member.split('\n').forEach((line) => JSON.parse(line)));
    assert.equal(member.includes(shortSentinel), false);
    assert.equal(member.includes(typedSentinel), false);
    assert.deepEqual(findTraceCredentialResidue(member), []);
  }

  const actionRecords = redactedMembers[0].split('\n').map((line) => JSON.parse(line));
  assert.equal(actionRecords[0].params.value, '[REDACTED:INPUT]');
  assert.equal(actionRecords[1].params.text, '[REDACTED:INPUT]');
});
