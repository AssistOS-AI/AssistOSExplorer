// Pure helpers for the public-room WebMeet gate. They have no browser or
// Playwright dependency so their pass/fail logic can be unit-tested.

export const WEBMEET_AGENT_NAME = 'webmeetAgent';
export const WEBMEET_ROOM_ID_PATTERN = /^room_[0-9a-f-]{36}$/i;
export const PUBLIC_ROOM_DENIED_MESSAGE = 'This room is not available as a public room. Sign in to access WebMeet rooms.';
export const GUEST_ADMISSION_TOOLS = Object.freeze([
  'webmeet_room_join_guest',
  'webmeet_room_guest_get',
  'webmeet_chat_send_guest',
]);
export const SIGNED_IN_COOKIE_NAMES = Object.freeze(['ploinky_jwt', 'ploinky_sso']);
export const GUEST_COOKIE_NAME = 'ploinky_guest';

// The room link the WebMeet UI publishes: `<origin>/<agent>/roomLoader.html?roomId=<id>`.
export function publicRoomLoaderUrl(baseURL, roomId, agentName = WEBMEET_AGENT_NAME) {
  const id = String(roomId || '').trim();
  if (!WEBMEET_ROOM_ID_PATTERN.test(id)) throw new Error(`Invalid WebMeet room id: ${id}`);
  const url = new URL(`/${encodeURIComponent(agentName)}/roomLoader.html`, baseURL);
  url.searchParams.set('roomId', id);
  return url.toString();
}

// Names of the MCP tools named by a JSON-RPC POST body (single or batched).
export function mcpToolNamesFromPostData(postData) {
  let parsed;
  try {
    parsed = JSON.parse(String(postData || ''));
  } catch {
    return [];
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages
    .filter((message) => message && message.method === 'tools/call')
    .map((message) => String(message.params?.name || '').trim())
    .filter(Boolean);
}

export function forbiddenGuestAdmissionTools(toolNames) {
  return toolNames.filter((name) => GUEST_ADMISSION_TOOLS.includes(name));
}

// Cookie names must show a router-created guest session and no signed-in session.
export function describeGuestCookies(cookies) {
  const names = [...new Set(cookies.map((cookie) => String(cookie.name || '')))].sort();
  return {
    names,
    hasGuestSession: names.includes(GUEST_COOKIE_NAME),
    signedInCookies: names.filter((name) => SIGNED_IN_COOKIE_NAMES.includes(name)),
  };
}

// rows: [{ identity, local, name }] read from `webmeet-participant-card` elements.
export function evaluateGuestPresence(ownerRows, guestRows, guestDisplayName) {
  const ownerLocal = ownerRows.find((row) => row.local) || null;
  const guestLocal = guestRows.find((row) => row.local) || null;
  const guestSeenByOwner = Boolean(guestLocal && ownerRows.some((row) => (
    !row.local && row.identity === guestLocal.identity && row.name === guestDisplayName
  )));
  const ownerSeenByGuest = Boolean(ownerLocal && guestRows.some((row) => (
    !row.local && row.identity === ownerLocal.identity
  )));
  return {
    ownerLocalIdentity: ownerLocal?.identity || '',
    guestLocalIdentity: guestLocal?.identity || '',
    distinct: Boolean(ownerLocal && guestLocal && ownerLocal.identity !== guestLocal.identity),
    guestSeenByOwner,
    ownerSeenByGuest,
    ok: Boolean(ownerLocal && guestLocal && ownerLocal.identity !== guestLocal.identity
      && guestSeenByOwner && ownerSeenByGuest),
  };
}
