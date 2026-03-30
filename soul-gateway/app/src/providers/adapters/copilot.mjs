import { randomUUID } from 'node:crypto';
import { requestDeviceCode, pollForToken as pollDeviceFlow } from '../device-flow.mjs';
import copilotResponsesConverter from '../format-converters/copilot-responses.mjs';
import { createLogger } from '../../utils/logger.mjs';

const log = createLogger('adapter:copilot');

// ---- Constants ----

const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const COPILOT_CHAT_VERSION = '0.26.7';
const GITHUB_API_VERSION = '2025-04-01';
const VSCODE_VERSION_FALLBACK = '1.104.3';

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

// ---- VS Code version cache ----

let cachedVSCodeVersion = '';
let vscodeVersionFetched = false;

async function getVSCodeVersion() {
  if (vscodeVersionFetched) return cachedVSCodeVersion;

  try {
    const res = await fetch(
      'https://aur.archlinux.org/cgit/aur.git/plain/PKGBUILD?h=visual-studio-code-bin',
      { signal: AbortSignal.timeout(5000) }
    );
    const text = await res.text();
    const match = text.match(/pkgver=(\S+)/);
    if (match) {
      cachedVSCodeVersion = match[1];
      vscodeVersionFetched = true;
      log.debug('VS Code version fetched from AUR', { version: cachedVSCodeVersion });
      return cachedVSCodeVersion;
    }
  } catch (err) {
    log.warn('Failed to fetch VS Code version, using fallback', { error: err.message });
  }

  cachedVSCodeVersion = VSCODE_VERSION_FALLBACK;
  vscodeVersionFetched = true;
  log.debug('Using VS Code version fallback', { version: cachedVSCodeVersion });
  return cachedVSCodeVersion;
}

// ---- GitHub headers (used for token exchange) ----

function githubHeaders(githubToken, vsCodeVersion) {
  return {
    'content-type': 'application/json',
    'accept': 'application/json',
    'authorization': `token ${githubToken}`,
    'editor-version': `vscode/${vsCodeVersion}`,
    'editor-plugin-version': `copilot-chat/${COPILOT_CHAT_VERSION}`,
    'user-agent': `GitHubCopilotChat/${COPILOT_CHAT_VERSION}`,
    'x-github-api-version': GITHUB_API_VERSION,
  };
}

// ---- Copilot token exchange ----

async function exchangeForCopilotToken(githubToken) {
  const vsCodeVersion = await getVSCodeVersion();

  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: githubHeaders(githubToken, vsCodeVersion),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get Copilot token: ${res.status} ${res.statusText} — ${text}`);
  }

  const data = await res.json();
  // data.token = the Copilot JWT, data.expires_at = unix epoch, data.refresh_in = seconds
  return data;
}

// ---- Adapter interface ----

export default {
  name: 'copilot',
  authType: 'device-flow',
  callbackPort: null,
  refreshMarginMs: 60 * 1000, // Copilot tokens ~30min, refresh 1min before

  formatConverter: copilotResponsesConverter,

  /**
   * Start the GitHub device flow.
   * Returns { userCode, verificationUri, deviceCode, interval } for auth-manager.
   */
  async startAuth() {
    // Ensure VS Code version is cached before any auth flow
    await getVSCodeVersion();

    const result = await requestDeviceCode({
      deviceCodeUrl: GITHUB_DEVICE_CODE_URL,
      clientId: GITHUB_CLIENT_ID,
      scopes: 'read:user',
    });

    return {
      userCode: result.userCode,
      verificationUri: result.verificationUri,
      deviceCode: result.deviceCode,
      interval: result.interval,
    };
  },

  /**
   * Poll GitHub for the access token, then exchange it for a Copilot token.
   * Returns credential object to be stored by auth-manager.
   */
  async pollForToken(deviceCode, interval) {
    // Poll GitHub OAuth for the access token
    const tokenData = await pollDeviceFlow(
      {
        tokenUrl: GITHUB_TOKEN_URL,
        clientId: GITHUB_CLIENT_ID,
      },
      deviceCode,
      interval
    );

    const githubToken = tokenData.access_token;

    // Exchange GitHub token for Copilot token
    const copilotData = await exchangeForCopilotToken(githubToken);

    return {
      accessToken: copilotData.token,
      refreshToken: githubToken, // GitHub token used to refresh Copilot token
      expiresAt: copilotData.expires_at
        ? copilotData.expires_at * 1000  // convert unix seconds to ms
        : Date.now() + (copilotData.refresh_in || 1800) * 1000,
      email: tokenData.scope ? `github:${tokenData.scope}` : null,
    };
  },

  /**
   * Refresh an expiring Copilot token using the stored GitHub token.
   * Returns partial credential update to merge into stored account.
   */
  async refreshToken(creds) {
    const githubToken = creds.refreshToken;
    if (!githubToken) {
      throw new Error('No GitHub token available for Copilot token refresh');
    }

    const copilotData = await exchangeForCopilotToken(githubToken);

    return {
      accessToken: copilotData.token,
      expiresAt: copilotData.expires_at
        ? copilotData.expires_at * 1000
        : Date.now() + (copilotData.refresh_in || 1800) * 1000,
    };
  },

  /**
   * Build Copilot-specific request headers for upstream API calls.
   * Spoofs VS Code editor identity as required by the Copilot API.
   */
  async getHeaders(creds) {
    const vsCodeVersion = await getVSCodeVersion();

    return {
      'Authorization': `Bearer ${creds.accessToken}`,
      'content-type': 'application/json',
      'copilot-integration-id': 'vscode-chat',
      'editor-version': `vscode/${vsCodeVersion}`,
      'editor-plugin-version': `copilot-chat/${COPILOT_CHAT_VERSION}`,
      'user-agent': `GitHubCopilotChat/${COPILOT_CHAT_VERSION}`,
      'openai-intent': 'conversation-panel',
      'x-github-api-version': GITHUB_API_VERSION,
      'x-request-id': randomUUID(),
    };
  },
};
