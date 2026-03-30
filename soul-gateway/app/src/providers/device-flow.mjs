import { createLogger } from '../utils/logger.mjs';

const log = createLogger('device-flow');

/**
 * Request a device code from the authorization server.
 * @param {object} config - { deviceCodeUrl, clientId, scopes, extraParams, extraHeaders }
 * @returns {{ userCode, verificationUri, deviceCode, interval, expiresIn }}
 */
export async function requestDeviceCode(config) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    scope: config.scopes || '',
    ...(config.extraParams || {}),
  });

  const res = await fetch(config.deviceCodeUrl, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(config.extraHeaders || {}),
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Device code request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri || data.verification_url,
    deviceCode: data.device_code,
    interval: data.interval || 5,
    expiresIn: data.expires_in || 900,
  };
}

/**
 * Poll for token after user enters the device code.
 * @param {object} config - { tokenUrl, clientId, extraHeaders }
 * @param {string} deviceCode
 * @param {number} interval - polling interval in seconds
 * @returns {object} token response from provider
 */
export async function pollForToken(config, deviceCode, interval = 5) {
  const deadline = Date.now() + 900_000; // 15 minute timeout
  let pollInterval = (interval + 1) * 1000; // add 1s safety margin

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollInterval));

    const body = new URLSearchParams({
      client_id: config.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });

    const res = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(config.extraHeaders || {}),
      },
      body: body.toString(),
    });

    const data = await res.json();

    if (data.access_token) {
      log.info('Device flow completed successfully');
      return data;
    }

    if (data.error === 'slow_down') {
      pollInterval += 5000;
      continue;
    }

    if (data.error === 'authorization_pending') {
      continue;
    }

    if (data.error === 'expired_token') {
      throw new Error('Device flow expired — user did not authorize in time');
    }

    if (data.error) {
      throw new Error(`Device flow error: ${data.error} — ${data.error_description || ''}`);
    }
  }

  throw new Error('Device flow timed out');
}
