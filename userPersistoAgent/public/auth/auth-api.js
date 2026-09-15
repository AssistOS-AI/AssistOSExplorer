function readJson(response) {
  return response.json().catch(() => ({}));
}

export async function postJson(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  const body = await readJson(response);
  if (!response.ok || body.ok === false) {
    const error = new Error(body.error || `Request failed with status ${response.status}`);
    error.payload = body;
    throw error;
  }
  return body;
}

export function loginParams() {
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get('clientId') || '';
  return {
    requestId: params.get('requestId') || '',
    state: params.get('state') || '',
    clientId
  };
}

export function decodeSetupPayload() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const encoded = params.get('setup');
  if (!encoded) throw new Error('Passkey setup data is missing.');
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  return JSON.parse(decodeURIComponent(escape(atob(padded))));
}

export function toBuffer(value) {
  const base64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function toBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function publicKeyRequestFromServer(publicKey) {
  const options = { ...publicKey };
  options.challenge = toBuffer(options.challenge);
  options.allowCredentials = (options.allowCredentials || []).map((credential) => ({
    ...credential,
    id: toBuffer(credential.id)
  }));
  return options;
}

export function publicKeyCreationFromServer(publicKey) {
  const options = { ...publicKey };
  options.challenge = toBuffer(options.challenge);
  options.user = { ...(options.user || {}), id: toBuffer(options.user && options.user.id) };
  options.excludeCredentials = (options.excludeCredentials || []).map((credential) => ({
    ...credential,
    id: toBuffer(credential.id)
  }));
  return options;
}

export function assertionCredentialToServer(credential) {
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64Url(credential.response.clientDataJSON),
      authenticatorData: toBase64Url(credential.response.authenticatorData),
      signature: toBase64Url(credential.response.signature),
      userHandle: credential.response.userHandle ? toBase64Url(credential.response.userHandle) : ''
    }
  };
}

export function attestationCredentialToServer(credential) {
  const response = {
    clientDataJSON: toBase64Url(credential.response.clientDataJSON),
    attestationObject: toBase64Url(credential.response.attestationObject)
  };
  if (typeof credential.response.getTransports === 'function') {
    response.transports = credential.response.getTransports();
  }
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response
  };
}
