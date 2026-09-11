import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function readBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function readInt(name, fallback) {
  const value = Number.parseInt(String(process.env[name] || ''), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '') || 'http://127.0.0.1:8080';
}

function defaultRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${stamp}-${process.pid}`;
}

function resolveOptionalPath(value) {
  const text = String(value || '').trim();
  return text ? path.resolve(text) : '';
}

// UserPersisto accounts are passwordless. The designated administrator may use
// the deployment-configured administrator password; other accounts use an
// email code or an enrolled authenticator app.
const SIGN_IN_METHODS = new Set(['adminPassword', 'emailCode', 'totp']);
function readSignInMethod(name, fallback) {
  const value = String(process.env[name] || '').trim();
  return SIGN_IN_METHODS.has(value) ? value : fallback;
}

const runId = String(process.env.SMOKE_RUN_ID || defaultRunId()).replace(/[^A-Za-z0-9_-]/g, '-');
const qaAcceptance = readBool('SMOKE_QA_ACCEPTANCE', false);
const workspaceRoot = resolveOptionalPath(process.env.SMOKE_WORKSPACE_ROOT);
const dpuDataRoot = resolveOptionalPath(process.env.SMOKE_DPU_DATA_ROOT)
  || (workspaceRoot ? path.join(workspaceRoot, '.data', 'dpu-data') : path.join(repoRoot, '.data', 'dpu-data'));
const artifactRoot = path.resolve(
  process.env.SMOKE_ARTIFACT_DIR || path.join(repoRoot, '.ploinky', 'test-artifacts', 'headless-smoke', runId)
);
fs.mkdirSync(artifactRoot, { recursive: true });

export const smokeConfig = Object.freeze({
  repoRoot,
  runId,
  artifactRoot,
  workspaceRoot,
  dpuDataRoot,
  baseURL: stripTrailingSlash(
    process.env.SMOKE_BASE_URL
      || process.env.PLAYWRIGHT_BASE_URL
      || (qaAcceptance ? 'https://explorer-qa.axiologic.dev' : '')
  ),
  qaEdgeIP: String(process.env.SMOKE_QA_EDGE_IP || '').trim(),
  authAgent: process.env.SMOKE_AUTH_AGENT || 'explorer',
  // Deployment-configured UserPersisto administrator password; never defaulted.
  administratorPassword: String(process.env.SMOKE_ADMIN_PASSWORD || ''),
  // Shell command printing the latest UserPersisto code for $SMOKE_EMAIL.
  emailCodeCommand: String(process.env.SMOKE_EMAIL_CODE_COMMAND || '').trim(),
  accountEmailDomain: String(process.env.SMOKE_ACCOUNT_EMAIL_DOMAIN || 'example.test').trim(),
  // `password` applies only to Ploinky's local /auth/login form.
  primaryUser: {
    username: process.env.SMOKE_USERNAME || 'admin',
    loginEmail: process.env.SMOKE_LOGIN_EMAIL || process.env.SMOKE_USERNAME || 'admin',
    password: process.env.SMOKE_PASSWORD || 'admin',
    signInMethod: readSignInMethod('SMOKE_SIGN_IN_METHOD', 'adminPassword'),
    totpSecret: String(process.env.SMOKE_TOTP_SECRET || ''),
  },
  secondaryUser: {
    username: process.env.SMOKE_SECONDARY_USERNAME || 'user',
    loginEmail: process.env.SMOKE_SECONDARY_LOGIN_EMAIL || process.env.SMOKE_SECONDARY_USERNAME || 'user',
    password: process.env.SMOKE_SECONDARY_PASSWORD || 'user',
    signInMethod: readSignInMethod('SMOKE_SECONDARY_SIGN_IN_METHOD', 'emailCode'),
    totpSecret: String(process.env.SMOKE_SECONDARY_TOTP_SECRET || ''),
  },
  webchatAgent: process.env.SMOKE_WEBCHAT_AGENT || 'roboTeamAgent',
  webAssistSiteId: process.env.SMOKE_WEBASSIST_SITE_ID || 'demo-site',
  flags: {
    failOnBrowserErrors: !readBool('SMOKE_ALLOW_BROWSER_ERRORS', false),
    github: readBool('SMOKE_GITHUB', false),
    codexDelegation: readBool('SMOKE_CODEX_DELEGATION', false),
    gptResearcher: readBool('SMOKE_GPT_RESEARCHER', false),
    onlyoffice: readBool('SMOKE_ONLYOFFICE', false),
    openInterpreter: readBool('SMOKE_OPEN_INTERPRETER', false),
    qaAcceptance,
    umami: readBool('SMOKE_UMAMI', false),
    webttyCore: readBool('SMOKE_WEBTTY_CORE', false),
    webmeetHeadless: readBool('SMOKE_WEBMEET_HEADLESS', false),
    webmeetMedia: readBool('SMOKE_WEBMEET_MEDIA', false),
    webmeetNetworkMatrix: readBool('SMOKE_WEBMEET_NETWORK_MATRIX', false),
    webmeetRefresh: readBool('SMOKE_WEBMEET_REFRESH', false),
    webmeetScreen: readBool('SMOKE_WEBMEET_SCREEN', false),
  },
  timeouts: {
    action: readInt('SMOKE_ACTION_TIMEOUT_MS', 20_000),
    expect: readInt('SMOKE_EXPECT_TIMEOUT_MS', 12_000),
    navigation: readInt('SMOKE_NAVIGATION_TIMEOUT_MS', 45_000),
    test: readInt('SMOKE_TEST_TIMEOUT_MS', 120_000),
    relay: readInt('SMOKE_RELAY_TIMEOUT_MS', 420_000),
    media: readInt('SMOKE_MEDIA_TIMEOUT_MS', 60_000),
    webmeetRefresh: readInt('SMOKE_WEBMEET_REFRESH_MAX_WAIT_MS', 180_000),
  },
});

export function smokeArtifactPath(...segments) {
  const target = path.join(smokeConfig.artifactRoot, ...segments);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return target;
}
