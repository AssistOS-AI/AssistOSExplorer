import { isDeepStrictEqual } from 'node:util';

import {
  acknowledgeExactPageDiagnostics,
  checkpointPageDiagnostics,
  expect,
} from './fixtures.mjs';

const unauthorizedBody = { error: { message: 'Unauthorized', code: 'unauthorized', status: 401 } };
const unauthorizedConsoles = new Set([
  'Failed to load resource: the server responded with a status of 401 (Unauthorized)',
  'Failed to load resource: the server responded with a status of 401 ()',
]);

export function beginUmamiSignedOutProof(page, { verifyUrl, timeout }) {
  const checkpoint = checkpointPageDiagnostics(page, 'Umami signed-out login authorization check');
  const responses = [];
  const consoles = [];
  const onResponse = (response) => {
    if (response.url() !== verifyUrl) return;
    responses.push({
      response,
      bodyProof: response.json().then(
        (body) => ({ readable: true, exact: isDeepStrictEqual(body, unauthorizedBody) }),
        () => ({ readable: false, exact: false }),
      ),
      completed: response.finished().then((error) => error === null, () => false),
    });
  };
  const onConsole = (message) => {
    if (message.type() === 'error' && unauthorizedConsoles.has(message.text())
      && message.location().url === verifyUrl) consoles.push(message);
  };
  page.on('response', onResponse);
  page.on('console', onConsole);

  return async function assertAndAcknowledgeSignedOut() {
    try {
      // The explicit login entry verifies that no application session exists
      // before the form receives credentials.
      await expect.poll(() => ({ responses: responses.length, consoles: consoles.length }), {
        message: 'Umami must complete exactly one signed-out login authorization check',
        timeout,
      }).toEqual({ responses: 1, consoles: 1 });
      for (const { response, bodyProof, completed } of responses) {
        expect(response.request().method(), 'Umami signed-out verification method').toBe('POST');
        expect(response.status(), 'Umami signed-out verification status').toBe(401);
        expect(await completed, 'Umami denial response must complete').toBe(true);
        expect(response.request().failure() === null, 'Umami denial request must not fail').toBe(true);
        expect(response.headers()['content-type'] || '').toMatch(/^application\/json(?:;|$)/i);
        const body = await bodyProof;
        expect(body.readable, 'Umami signed-out verification must return readable JSON').toBe(true);
        expect(body.exact, 'Umami must return its exact generic denial body').toBe(true);
      }
      expect(responses.length, 'no additional prelogin verification response is permitted').toBe(1);
      expect(consoles.length, 'no additional prelogin denial console is permitted').toBe(1);
      const expected = [
        { kind: 'response', type: 'error', status: 401, url: verifyUrl, method: 'POST' },
        { kind: 'console', type: 'error', text: consoles[0].text(), locationUrl: verifyUrl },
      ];
      acknowledgeExactPageDiagnostics(page, checkpoint, expected);
      return { signedOutVerifications: 1, status: 401, completed: true };
    } finally {
      page.off('response', onResponse);
      page.off('console', onConsole);
    }
  };
}

export async function verifyUmamiBrowserAuthorization(page, { path, expectedUsername }) {
  return page.evaluate(async ({ path, expectedUsername }) => {
    let token;
    try {
      token = JSON.parse(localStorage.getItem('umami.auth') || 'null');
    } catch (_) {
      return { hasToken: false };
    }
    if (typeof token !== 'string' || !token) return { hasToken: false };
    const verification = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    let user;
    try {
      user = await verification.json();
    } catch (_) {
      return { hasToken: true, status: verification.status, validUser: false };
    }
    return {
      hasToken: true,
      status: verification.status,
      validUser: Boolean(user && typeof user.id === 'string' && user.id.length > 0
        && user.username === expectedUsername && typeof user.role === 'string' && user.role.length > 0
        && typeof user.isAdmin === 'boolean' && Array.isArray(user.teams)),
    };
  }, { path, expectedUsername });
}
