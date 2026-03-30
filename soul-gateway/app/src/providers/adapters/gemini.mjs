import { requestDeviceCode, pollForToken } from '../device-flow.mjs';
import { createLogger } from '../../utils/logger.mjs';

const log = createLogger('gemini-auth');

export default {
  name: 'gemini',
  authType: 'device-flow',
  callbackPort: null,
  refreshMarginMs: 5 * 60 * 1000,

  config: {
    deviceCodeUrl: 'https://oauth2.googleapis.com/device/code',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    scopes: 'openid email https://www.googleapis.com/auth/generative-language',
  },

  async startAuth() {
    if (!this.config.clientId) {
      throw new Error('GOOGLE_OAUTH_CLIENT_ID environment variable not set');
    }
    const result = await requestDeviceCode(this.config);
    return {
      userCode: result.userCode,
      verificationUri: result.verificationUri,
      deviceCode: result.deviceCode,
      interval: result.interval,
    };
  },

  async pollForToken(deviceCode, interval) {
    const data = await pollForToken(this.config, deviceCode, interval);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
      email: null,
    };
  },

  async refreshToken(creds) {
    if (!creds.refreshToken) throw new Error('No refresh token available');

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      refresh_token: creds.refreshToken,
    });

    const res = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) throw new Error(`Google token refresh failed: ${res.status}`);
    const data = await res.json();

    return {
      ...creds,
      accessToken: data.access_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : creds.expiresAt,
    };
  },

  async getHeaders(creds) {
    return {
      'Authorization': `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
    };
  },

  formatConverter: null,
  credentialsDir: '/shared/soul-gateway/providers/gemini/',
};
