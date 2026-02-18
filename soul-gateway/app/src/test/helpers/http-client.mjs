/**
 * Fetch wrappers with auth helpers for integration tests.
 */
import { baseUrl } from './test-setup.mjs';

let sessionCookie = null;

export function setSessionCookie(cookie) {
  sessionCookie = cookie;
}

export function clearSessionCookie() {
  sessionCookie = null;
}

function headers(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (sessionCookie) {
    h['Cookie'] = sessionCookie;
  }
  return h;
}

export async function get(path, opts = {}) {
  return fetch(`${baseUrl()}${path}`, {
    method: 'GET',
    headers: headers(opts.headers),
    redirect: 'manual',
  });
}

export async function post(path, body, opts = {}) {
  return fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: headers(opts.headers),
    body: typeof body === 'string' ? body : JSON.stringify(body),
    redirect: 'manual',
  });
}

export async function put(path, body, opts = {}) {
  return fetch(`${baseUrl()}${path}`, {
    method: 'PUT',
    headers: headers(opts.headers),
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

export async function del(path, opts = {}) {
  return fetch(`${baseUrl()}${path}`, {
    method: 'DELETE',
    headers: headers(opts.headers),
    redirect: 'manual',
  });
}

export async function options(path) {
  return fetch(`${baseUrl()}${path}`, {
    method: 'OPTIONS',
    redirect: 'manual',
  });
}

/**
 * Login to the dashboard and store the session cookie.
 */
export async function login(password) {
  const res = await fetch(`${baseUrl()}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(password)}`,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    // Extract just the cookie name=value part
    sessionCookie = setCookie.split(';')[0];
  }
  return res;
}

/**
 * Make a chat completions request with an API key.
 */
export async function chatCompletions(body, apiKey) {
  return fetch(`${baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}
