import { createHmac } from 'node:crypto';
import { config } from '../config.mjs';
import { readBody } from '../utils/http-helpers.mjs';

const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = 'soul_session';

function makeHmac(timestamp) {
  return createHmac('sha256', config.dashboardPassword)
    .update(String(timestamp))
    .digest('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const pair of header.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) cookies[k] = v.join('=');
  }
  return cookies;
}

export function isAuthenticated(req) {
  if (!config.dashboardPassword) return true;
  const cookies = parseCookies(req);
  const session = cookies[COOKIE_NAME];
  if (!session) return false;
  const [ts, hmac] = session.split('.');
  if (!ts || !hmac) return false;
  const timestamp = Number(ts);
  if (Date.now() - timestamp > SESSION_MAX_AGE) return false;
  return makeHmac(timestamp) === hmac;
}

export function handleLogin(req, res) {
  if (req.method === 'GET') {
    return serveLoginPage(res);
  }
  if (req.method === 'POST') {
    return handleLoginPost(req, res);
  }
  res.writeHead(405);
  res.end('Method not allowed');
}

export function handleLogout(req, res) {
  res.writeHead(302, {
    'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    'Location': '/login',
  });
  res.end();
}

async function handleLoginPost(req, res) {
  const body = await readBody(req);
  const params = new URLSearchParams(body);
  const password = params.get('password') || '';

  if (password !== config.dashboardPassword) {
    return serveLoginPage(res, 'Invalid password');
  }

  const timestamp = Date.now();
  const hmac = makeHmac(timestamp);
  const cookie = `${timestamp}.${hmac}`;
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';

  res.writeHead(302, {
    'Set-Cookie': `${COOKIE_NAME}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE / 1000}${secure}`,
    'Location': '/',
  });
  res.end();
}

export function redirectToLogin(res) {
  res.writeHead(302, { 'Location': '/login' });
  res.end();
}

function serveLoginPage(res, error = '') {
  const errorHtml = error
    ? `<div class="alert alert-error mb-4"><span>${error}</span></div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Soul Gateway - Login</title>
  <link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.14/dist/full.min.css" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-base-200 flex items-center justify-center">
  <div class="card w-96 bg-base-100 shadow-xl">
    <div class="card-body">
      <h2 class="card-title justify-center text-2xl mb-2">Soul Gateway</h2>
      <p class="text-center text-base-content/60 mb-4">Enter password to access the dashboard</p>
      ${errorHtml}
      <form method="POST" action="/login">
        <div class="form-control mb-4">
          <input type="password" name="password" placeholder="Password"
                 class="input input-bordered w-full" autofocus required>
        </div>
        <button type="submit" class="btn btn-primary w-full">Login</button>
      </form>
    </div>
  </div>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
