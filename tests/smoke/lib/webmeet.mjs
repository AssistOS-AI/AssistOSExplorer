import { expect, setPageDiagnosticsExpectedOffline } from './fixtures.mjs';
import { signIn, trySignIn } from './auth.mjs';
import { smokeConfig } from './config.mjs';
import { requirePublicIpv4 } from './network.mjs';
import { screenRuntimeEvidenceProvesUdpMux } from './screen-runtime-evidence.mjs';
import { findSecretLeaks } from './security.mjs';

function webMeetDashboardPath() {
  const params = new URLSearchParams({
    webmeetSmoke: smokeConfig.runId,
  });
  if (smokeConfig.flags.webmeetMedia) {
    params.set('webmeetMediaDebug', '1');
  }
  return `/explorer/index.html?${params.toString()}#webmeet-dashboard`;
}

export async function expectWebMeetReady(page, { expectCreateRoom = true } = {}) {
  await expect(page.locator('div.webmeet-dashboard')).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
  if (expectCreateRoom) {
    await expect(page.locator('#webmeetCreateRoomButton')).toBeVisible();
  }
}

async function prepareWebMeetPage(page) {
  if (smokeConfig.flags.webmeetMedia) {
    await page.addInitScript(() => {
      globalThis.WEBMEET_MEDIA_DEBUG = true;
    });
  }
}

export async function trySignInToWebMeet(page, account = smokeConfig.primaryUser) {
  await prepareWebMeetPage(page);
  return trySignIn(page, account, webMeetDashboardPath());
}

export async function openWebMeet(page, account = smokeConfig.primaryUser, options = {}) {
  const { expectCreateRoom = true, requireConfiguredPrincipal = false } = options;
  await prepareWebMeetPage(page);
  const principal = await signIn(page, account, webMeetDashboardPath(), { requireConfiguredPrincipal });
  await expectWebMeetReady(page, { expectCreateRoom });
  return principal;
}

export async function openStandaloneWebMeet(page, { roomId = '' } = {}) {
  const path = new URL('/webmeetAgent/roomLoader.html', smokeConfig.baseURL);
  if (roomId) path.searchParams.set('roomId', roomId);
  const response = await page.goto(`${path.pathname}${path.search}`, { waitUntil: 'domcontentloaded' });
  expect(response, 'standalone WebMeet navigation must produce a document response').not.toBeNull();
  expect(response.status(), 'standalone WebMeet document must be served by WebMeet').toBe(200);
  expect(new URL(page.url()).pathname).toBe('/webmeetAgent/roomLoader.html');
  await expect(page.locator('body')).not.toContainText(/^Not Found$/);
  return response;
}

export async function expectAuthenticatedStandaloneWebMeet(page) {
  await openStandaloneWebMeet(page);
  await expect(page.locator('div.webmeet-dashboard')).toBeVisible({
    timeout: smokeConfig.timeouts.navigation,
  });
  await expect(page.locator('#webmeetCreateRoomButton')).toBeVisible();
}

export async function joinStandaloneGuestRoom(page, { roomId, displayName }) {
  await openStandaloneWebMeet(page, { roomId });
  await expect(page.locator('#webmeetGuestEntryName')).toBeVisible({
    timeout: smokeConfig.timeouts.navigation,
  });
  await page.locator('#webmeetGuestEntryName').fill(displayName);
  await page.locator('#webmeetGuestEntrySubmit').click();
  await expect(page.locator('#webmeetChatInput')).toBeVisible({
    timeout: smokeConfig.timeouts.media,
  });
}

export async function createRoom(page, title, { roomType = 'team' } = {}) {
  await page.locator('#webmeetCreateRoomButton').click();
  await expect(page.locator('[data-id="roomTitleInput"]')).toBeVisible();
  if (roomType === 'guest') {
    const guestRoomType = page.locator('[data-id="roomTypeGuest"]');
    await page.locator('label.room-type-option', { hasText: 'Public meeting' }).click();
    await expect(guestRoomType).toBeChecked();
  } else if (roomType !== 'team') {
    throw new Error(`Unsupported WebMeet room type: ${roomType}`);
  }
  await page.locator('[data-id="roomTitleInput"]').fill(title);
  await page.locator('[data-local-action="confirmCreate"]').click();
  if (roomType === 'guest') {
    const confirmationDialog = page.locator('dialog:has(confirm-action-modal)').last();
    await expect(confirmationDialog).toBeVisible();
    await confirmationDialog.getByRole('button', { name: 'No' }).click();
  }
  const room = page.locator('#webmeetMeetingList .webmeet-list-item', { hasText: title }).first();
  await expect(room).toBeVisible();
  const roomId = String(await room.getAttribute('data-id') || '').trim();
  expect(roomId, `created WebMeet room '${title}' must expose its room id`).toMatch(/^room_[0-9a-f-]{36}$/i);
  return roomId;
}

export async function joinRoom(page, title) {
  await page.locator('#webmeetMeetingList .webmeet-list-item', { hasText: title }).first().locator('.webmeet-meeting-row').click();
/*  await expect(page.locator('#webmeetActiveRoomTitle')).toContainText(title);*/
  await expect(page.locator('#webmeetChatInput')).toBeVisible();
}

export async function sendWebMeetChat(page, message) {
  await page.locator('#webmeetChatInput').fill(message);
  await page.locator('.webmeet-compose [data-local-action="sendChat"]').click();
  await expect(page.locator('#webmeetChatList', { hasText: message })).toBeVisible();
}

export async function expectWebMeetSuggestion(page, { group, text }) {
  await expect(page.locator('.webmeet-chat-suggest-menu')).toBeVisible();
  if (group) {
    await expect(page.locator('.webmeet-chat-suggest-group', { hasText: group })).toBeVisible();
  }
  await expect(page.locator('.webmeet-chat-suggest-item', { hasText: text }).first()).toBeVisible();
}

export async function selectActiveWebMeetSuggestion(page) {
  await page.keyboard.press('Enter');
}

export async function deleteRoomIfPresent(page, title) {
  const matchingRooms = page
    .locator('#webmeetMeetingList .webmeet-list-item')
    .filter({ has: page.getByText(title, { exact: true }) });
  let deleted = false;
  while (await matchingRooms.count()) {
    const item = matchingRooms.first();
    await item.hover();
    await item.getByRole('button', { name: 'Room settings' }).click();

    const settingsDialog = page.locator('dialog:has(webmeet-room-settings-modal)').last();
    await expect(settingsDialog).toBeVisible();
    await settingsDialog.getByRole('tab', { name: 'Lifecycle' }).click();
    await settingsDialog.getByRole('button', { name: 'Delete room' }).click();

    const confirmationDialog = page.locator('dialog:has(confirm-action-modal)').last();
    await expect(confirmationDialog).toBeVisible();
    await expect(confirmationDialog).toContainText(title);
    await expect(confirmationDialog).toContainText(/cannot\s+be\s+undone/i);
    await confirmationDialog.getByRole('button', { name: 'Yes' }).click();

    await expect(item).toHaveCount(0, { timeout: smokeConfig.timeouts.navigation });
    deleted = true;
  }
  await expect(matchingRooms).toHaveCount(0);
  return deleted;
}

export async function enableMedia(page) {
  await page.locator('#webmeetMicButton').click();
  await page.locator('#webmeetCameraButton').click();
  await expect(page.locator('#webmeetVideoGrid video').first()).toBeVisible({ timeout: smokeConfig.timeouts.media });
}

export async function expectIncreasingRtpStats(page) {
  const first = await page.evaluate(async () => {
    const pcs = window.__e2ePeerConnections || [];
    const rows = [];
    for (const pc of pcs) {
      const stats = await pc.getStats();
      stats.forEach((entry) => {
        if (entry.type === 'outbound-rtp' || entry.type === 'inbound-rtp') {
          rows.push({
            type: entry.type,
            kind: entry.kind || entry.mediaType || '',
            packets: entry.packetsSent || entry.packetsReceived || 0,
            frames: entry.framesEncoded || entry.framesDecoded || 0,
          });
        }
      });
    }
    return rows;
  });
  await page.waitForTimeout(2_500);
  const second = await page.evaluate(async () => {
    const pcs = window.__e2ePeerConnections || [];
    const rows = [];
    for (const pc of pcs) {
      const stats = await pc.getStats();
      stats.forEach((entry) => {
        if (entry.type === 'outbound-rtp' || entry.type === 'inbound-rtp') {
          rows.push({
            type: entry.type,
            kind: entry.kind || entry.mediaType || '',
            packets: entry.packetsSent || entry.packetsReceived || 0,
            frames: entry.framesEncoded || entry.framesDecoded || 0,
          });
        }
      });
    }
    return rows;
  });
  const before = first.reduce((sum, row) => sum + row.packets + row.frames, 0);
  const after = second.reduce((sum, row) => sum + row.packets + row.frames, 0);
  expect(after).toBeGreaterThan(before);
}

async function bidirectionalMediaRtpSnapshot(page, peerConnectionIndices = null) {
  return page.evaluate(async (requiredPeerConnectionIndices) => {
    const required = Array.isArray(requiredPeerConnectionIndices)
      ? new Set(requiredPeerConnectionIndices)
      : null;
    const groups = Object.fromEntries([
      'outbound-rtp:audio',
      'outbound-rtp:video',
      'inbound-rtp:audio',
      'inbound-rtp:video',
    ].map((key) => [key, { packets: 0, bytes: 0, frames: 0, rows: [] }]));
    for (const [peerConnectionIndex, pc] of (window.__e2ePeerConnections || []).entries()) {
      if (required && !required.has(peerConnectionIndex)) continue;
      const stats = await pc.getStats();
      stats.forEach((entry) => {
        if (!['outbound-rtp', 'inbound-rtp'].includes(entry.type) || entry.isRemote) return;
        const kind = String(entry.kind || entry.mediaType || '').toLowerCase();
        const key = `${entry.type}:${kind}`;
        if (!Object.hasOwn(groups, key)) return;
        const direction = entry.type === 'outbound-rtp' ? 'outbound' : 'inbound';
        const row = {
          peerConnectionIndex,
          statId: String(entry.id || ''),
          ssrc: String(entry.ssrc || ''),
          direction,
          kind,
          packets: Number(direction === 'outbound' ? entry.packetsSent : entry.packetsReceived) || 0,
          bytes: Number(direction === 'outbound' ? entry.bytesSent : entry.bytesReceived) || 0,
          frames: Number(direction === 'outbound' ? entry.framesEncoded : entry.framesDecoded) || 0,
        };
        groups[key].packets += row.packets;
        groups[key].bytes += row.bytes;
        groups[key].frames += row.frames;
        groups[key].rows.push(row);
      });
    }
    return groups;
  }, peerConnectionIndices);
}

export async function expectBidirectionalAudioVideoRtp(page, { label, testInfo, peerConnectionIndices = null }) {
  if (peerConnectionIndices !== null) {
    expect(peerConnectionIndices.length, `${label} must scope RTP to a newly connected peer connection`).toBeGreaterThan(0);
  }
  const before = await bidirectionalMediaRtpSnapshot(page, peerConnectionIndices);
  let after = before;
  const requiredGroups = [
    'outbound-rtp:audio',
    'outbound-rtp:video',
    'inbound-rtp:audio',
    'inbound-rtp:video',
  ];
  await expect.poll(async () => {
    after = await bidirectionalMediaRtpSnapshot(page, peerConnectionIndices);
    return requiredGroups.every((key) => {
      const baseline = before[key];
      const current = after[key];
      const videoFramesGrow = key.endsWith(':video') ? current.frames > baseline.frames : true;
      return current.rows.length > 0
        && current.packets > baseline.packets
        && current.bytes > baseline.bytes
        && videoFramesGrow;
    });
  }, {
    message: `${label} must have distinct growing outbound/inbound audio and video RTP counters`,
    timeout: smokeConfig.timeouts.media,
    intervals: [500, 1_000, 2_000],
  }).toBe(true);

  const statIds = requiredGroups.flatMap((key) => (
    after[key].rows.map((row) => `${row.peerConnectionIndex}:${row.statId}`)
  ));
  expect(new Set(statIds).size, `${label} RTP directions and media kinds must use distinct stats rows`).toBe(statIds.length);
  await attachJsonEvidence(testInfo, `${label}-bidirectional-audio-video-rtp`, {
    peerConnectionIndices,
    before,
    after,
  });
  return { before, after };
}

async function webMeetMediaStateSnapshot(page) {
  return page.evaluate(async () => {
    const dashboard = document.querySelector('webmeet-dashboard');
    const presenter = dashboard?.webSkelPresenter || null;
    const room = presenter?.room
      || presenter?.roomLiveKit?.getRoom?.()
      || presenter?.roomController?.room
      || null;
    const localParticipant = room?.localParticipant || null;
    const publicationRows = (participant, local) => Array.from(participant?.trackPublications?.values?.() || [])
      .map((publication) => ({
        participantIdentity: String(participant?.identity || '').trim(),
        local,
        publicationSid: String(publication?.trackSid || publication?.sid || '').trim(),
        source: String(publication?.source || '').trim(),
        kind: String(publication?.kind || publication?.track?.kind || '').trim(),
        muted: Boolean(publication?.isMuted),
        subscribed: local ? true : Boolean(publication?.isSubscribed),
        trackId: String(publication?.track?.mediaStreamTrack?.id || '').trim(),
        trackState: String(publication?.track?.mediaStreamTrack?.readyState || '').trim(),
        trackPresent: Boolean(publication?.track?.mediaStreamTrack),
      }));
    const publications = [
      ...publicationRows(localParticipant, true),
      ...Array.from(room?.remoteParticipants?.values?.() || [])
        .flatMap((participant) => publicationRows(participant, false)),
    ];
    const videos = Array.from(document.querySelectorAll('#webmeetVideoGrid webmeet-participant-card video'))
      .map((video) => {
        const participant = video.closest('webmeet-participant-card[data-participant-id]');
        const tracks = Array.from(video.srcObject?.getVideoTracks?.() || []);
        const rect = video.getBoundingClientRect();
        const style = getComputedStyle(video);
        return {
          participantIdentity: String(participant?.dataset?.participantId || '').trim(),
          local: String(participant?.dataset?.local || participant?.getAttribute?.('data-is-local') || '') === 'true',
          connected: video.isConnected,
          visible: video.isConnected
            && rect.width > 0
            && rect.height > 0
            && style.visibility !== 'hidden'
            && style.display !== 'none'
            && Number(style.opacity || 1) > 0,
          paused: Boolean(video.paused),
          ended: Boolean(video.ended),
          readyState: Number(video.readyState || 0),
          currentTime: Number(video.currentTime || 0),
          videoWidth: Number(video.videoWidth || 0),
          videoHeight: Number(video.videoHeight || 0),
          tracks: tracks.map((track) => ({
            id: String(track?.id || '').trim(),
            readyState: String(track?.readyState || '').trim(),
            enabled: Boolean(track?.enabled),
            muted: Boolean(track?.muted),
          })),
        };
      });
    const dataChannels = [];
    for (const [peerConnectionIndex, peerConnection] of (window.__e2ePeerConnections || []).entries()) {
      const stats = await peerConnection.getStats();
      stats.forEach((entry) => {
        if (entry.type !== 'data-channel') return;
        dataChannels.push({
          peerConnectionIndex,
          statId: String(entry.id || '').trim(),
          label: String(entry.label || '').trim(),
          protocol: String(entry.protocol || '').trim(),
          state: String(entry.state || '').trim(),
          messagesSent: Number(entry.messagesSent || 0),
          messagesReceived: Number(entry.messagesReceived || 0),
          bytesSent: Number(entry.bytesSent || 0),
          bytesReceived: Number(entry.bytesReceived || 0),
        });
      });
    }
    return { publications, videos, dataChannels };
  });
}

export async function expectWebMeetMediaState(page, { label, testInfo }) {
  let snapshot = null;
  await expect.poll(async () => {
    snapshot = await webMeetMediaStateSnapshot(page);
    const livePublication = (publication) => (
      publication.publicationSid
      && publication.trackPresent
      && publication.trackId
      && publication.trackState !== 'ended'
    );
    const localSources = new Set(snapshot.publications
      .filter((publication) => publication.local && livePublication(publication))
      .map((publication) => publication.source));
    const remoteSources = new Set(snapshot.publications
      .filter((publication) => !publication.local && publication.subscribed && livePublication(publication))
      .map((publication) => publication.source));
    const playingVideo = (video) => (
      video.participantIdentity
      && video.connected
      && video.visible
      && !video.paused
      && !video.ended
      && video.readyState >= 2
      && video.currentTime > 0
      && video.videoWidth > 0
      && video.videoHeight > 0
      && video.tracks.some((track) => track.id && track.readyState === 'live' && track.enabled)
    );
    const openChannelLabels = snapshot.dataChannels
      .filter((channel) => channel.state === 'open')
      .map((channel) => channel.label.toLowerCase());
    return localSources.has('microphone')
      && localSources.has('camera')
      && remoteSources.has('microphone')
      && remoteSources.has('camera')
      && snapshot.videos.some((video) => video.local && playingVideo(video))
      && snapshot.videos.some((video) => !video.local && playingVideo(video))
      && openChannelLabels.some((channelLabel) => channelLabel.includes('reliable'))
      && openChannelLabels.some((channelLabel) => channelLabel.includes('lossy'));
  }, {
    message: `${label} must retain live local/remote publications, playing DOM videos, and open reliable/lossy DataChannels`,
    timeout: smokeConfig.timeouts.media,
    intervals: [500, 1_000, 2_000],
  }).toBe(true);
  await attachJsonEvidence(testInfo, `${label}-media-publication-dom-datachannel`, snapshot);
  const screenshotPath = testInfo.outputPath(`${label}-media-dom.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(`${label}-media-dom-screenshot`, {
    path: screenshotPath,
    contentType: 'image/png',
  });
  return snapshot;
}

const SCREEN_SOURCE = 'screen_share';

async function participantSnapshot(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('webmeet-participant-card[data-participant-id]'))
      .map((element) => ({
        identity: String(element.dataset.participantId || '').trim(),
        local: String(element.dataset.local || element.getAttribute('data-is-local') || '') === 'true',
      }))
      .filter((row) => row.identity);
    return {
      localIdentity: rows.find((row) => row.local)?.identity || '',
      identities: Array.from(new Set(rows.map((row) => row.identity))).sort(),
    };
  });
}

export async function expectTwoDistinctWebMeetParticipants(ownerPage, memberPage) {
  await expect.poll(async () => {
    const [owner, member] = await Promise.all([
      participantSnapshot(ownerPage),
      participantSnapshot(memberPage),
    ]);
    return Boolean(
      owner.localIdentity
      && member.localIdentity
      && owner.localIdentity !== member.localIdentity
      && owner.identities.includes(owner.localIdentity)
      && owner.identities.includes(member.localIdentity)
      && member.identities.includes(owner.localIdentity)
      && member.identities.includes(member.localIdentity)
    );
  }, {
    message: 'both isolated browser contexts must render both distinct LiveKit identities',
    timeout: smokeConfig.timeouts.media,
  }).toBe(true);

  const [owner, member] = await Promise.all([
    participantSnapshot(ownerPage),
    participantSnapshot(memberPage),
  ]);
  expect(owner.identities).toContain(member.localIdentity);
  expect(member.identities).toContain(owner.localIdentity);
  expect(owner.localIdentity).not.toBe(member.localIdentity);
  return {
    ownerIdentity: owner.localIdentity,
    memberIdentity: member.localIdentity,
  };
}

async function screenPublicationSnapshot(page) {
  return page.evaluate((screenSource) => {
    const dashboard = document.querySelector('webmeet-dashboard');
    const presenter = dashboard?.webSkelPresenter || null;
    const room = presenter?.room
      || presenter?.roomLiveKit?.getRoom?.()
      || presenter?.roomController?.room
      || null;
    const localParticipant = room?.localParticipant || null;
    const publications = Array.from(localParticipant?.trackPublications?.values?.() || [])
      .filter((publication) => String(publication?.source || '').trim() === screenSource)
      .map((publication) => ({
        participantIdentity: String(localParticipant?.identity || '').trim(),
        publicationSid: String(publication?.trackSid || publication?.sid || '').trim(),
        source: String(publication?.source || '').trim(),
        muted: Boolean(publication?.isMuted),
        trackId: String(publication?.track?.mediaStreamTrack?.id || '').trim(),
        trackState: String(publication?.track?.mediaStreamTrack?.readyState || '').trim(),
        trackPresent: Boolean(publication?.track?.mediaStreamTrack),
      }));
    const remotePublications = Array.from(room?.remoteParticipants?.values?.() || [])
      .flatMap((participant) => Array.from(participant?.trackPublications?.values?.() || [])
        .filter((publication) => String(publication?.source || '').trim() === screenSource)
        .map((publication) => ({
          participantIdentity: String(participant?.identity || '').trim(),
          publicationSid: String(publication?.trackSid || publication?.sid || '').trim(),
          source: String(publication?.source || '').trim(),
          muted: Boolean(publication?.isMuted),
          trackId: String(publication?.track?.mediaStreamTrack?.id || '').trim(),
          trackState: String(publication?.track?.mediaStreamTrack?.readyState || '').trim(),
          trackPresent: Boolean(publication?.track?.mediaStreamTrack),
        })));
    const receivers = Array.from(window.__e2ePeerConnections || []).flatMap((peerConnection, peerConnectionIndex) => (
      Array.from(peerConnection?.getReceivers?.() || []).map((receiver) => ({
        peerConnectionIndex,
        trackId: String(receiver?.track?.id || '').trim(),
        trackState: String(receiver?.track?.readyState || '').trim(),
        trackPresent: Boolean(receiver?.track),
      }))
    ));
    const videos = Array.from(document.querySelectorAll(`video[data-track-source="${screenSource}"]`))
      .map((video) => {
        const track = video.srcObject?.getVideoTracks?.()[0] || null;
        const participant = video.closest('[data-participant-id]');
        const rect = video.getBoundingClientRect();
        const style = getComputedStyle(video);
        return {
          participantIdentity: String(participant?.dataset?.participantId || '').trim(),
          local: String(participant?.dataset?.local || participant?.getAttribute?.('data-is-local') || '') === 'true',
          source: String(video.dataset.trackSource || '').trim(),
          trackId: String(track?.id || '').trim(),
          trackState: String(track?.readyState || '').trim(),
          trackPresent: Boolean(track),
          visible: video.isConnected
            && rect.width > 0
            && rect.height > 0
            && style.visibility !== 'hidden'
            && style.display !== 'none'
            && Number(style.opacity || 1) > 0,
          readyState: Number(video.readyState || 0),
          videoWidth: Number(video.videoWidth || 0),
          videoHeight: Number(video.videoHeight || 0),
          currentTime: Number(video.currentTime || 0),
        };
      });
    return {
      localIdentity: String(localParticipant?.identity || '').trim(),
      publications,
      remotePublications,
      receivers,
      videos,
      buttonActive: Boolean(document.querySelector('#webmeetScreenShareButton')?.classList.contains('active')),
    };
  }, SCREEN_SOURCE);
}

export function exactRemoteScreenTrackStopped(snapshot, reference) {
  const participantIdentity = String(reference?.participantIdentity || '').trim();
  const publicationSid = String(reference?.publicationSid || '').trim();
  const trackId = String(reference?.trackId || '').trim();
  if (!participantIdentity || !publicationSid || !trackId) return false;

  const publicationRows = Array.from(snapshot?.remotePublications || []).filter((publication) => (
    publication?.participantIdentity === participantIdentity
    && (publication?.publicationSid === publicationSid || publication?.trackId === trackId)
  ));
  const receiverRows = Array.from(snapshot?.receivers || []).filter((receiver) => receiver?.trackId === trackId);
  const videoRows = Array.from(snapshot?.videos || []).filter((video) => (
    video?.trackId === trackId
    || (video?.participantIdentity === participantIdentity && video?.source === SCREEN_SOURCE)
  ));
  const absentOrEnded = (rows) => rows.every((row) => !row?.trackPresent || row?.trackState === 'ended');
  return absentOrEnded(publicationRows) && absentOrEnded(receiverRows) && absentOrEnded(videoRows);
}

async function exactTrackRtpSnapshot(page, { direction, trackId }) {
  return page.evaluate(async ({ expectedDirection, expectedTrackId }) => {
    const pcs = window.__e2ePeerConnections || [];
    const rows = [];
    for (const [peerConnectionIndex, pc] of pcs.entries()) {
      const endpoints = expectedDirection === 'outbound' ? pc.getSenders() : pc.getReceivers();
      for (const endpoint of endpoints) {
        if (String(endpoint?.track?.id || '') !== expectedTrackId) continue;
        const stats = await endpoint.getStats();
        stats.forEach((entry) => {
          if (entry.type !== `${expectedDirection}-rtp`) return;
          const kind = String(entry.kind || entry.mediaType || '').toLowerCase();
          if (kind && kind !== 'video') return;
          rows.push({
            peerConnectionIndex,
            statId: String(entry.id || ''),
            direction: expectedDirection,
            trackId: expectedTrackId,
            packets: Number(expectedDirection === 'outbound' ? entry.packetsSent : entry.packetsReceived) || 0,
            frames: Number(expectedDirection === 'outbound' ? entry.framesEncoded : entry.framesDecoded) || 0,
          });
        });
      }
    }
    return {
      trackId: expectedTrackId,
      direction: expectedDirection,
      packets: rows.reduce((total, row) => total + row.packets, 0),
      frames: rows.reduce((total, row) => total + row.frames, 0),
      rows,
    };
  }, { expectedDirection: direction, expectedTrackId: trackId });
}

export async function rtcCandidateEvidence(page) {
  return page.evaluate(async () => {
    function parseTurnUrl(value) {
      const text = String(value || '').trim();
      const match = text.match(/^(turns?):(.*)$/i);
      if (!match) return null;
      try {
        const scheme = match[1].toLowerCase();
        const remainder = match[2].replace(/^\/\//, '');
        const url = new URL(`${scheme}://${remainder}`);
        const transport = String(url.searchParams.get('transport') || '').toLowerCase();
        if (!transport) return null;
        return {
          scheme,
          host: String(url.hostname || '').toLowerCase(),
          port: Number(url.port || (scheme === 'turns' ? 5349 : 3478)),
          transport,
        };
      } catch (_) {
        return null;
      }
    }

    const pcs = window.__e2ePeerConnections || [];
    const candidateEvents = window.__e2eIceCandidateEvents || [];
    const evidence = [];
    for (const [peerConnectionIndex, pc] of pcs.entries()) {
      const stats = await pc.getStats();
      stats.forEach((entry) => {
        if (entry.type !== 'candidate-pair') return;
        const transport = entry.transportId ? stats.get(entry.transportId) : null;
        const selected = Boolean(entry.selected || transport?.selectedCandidatePairId === entry.id);
        if (!selected && !(entry.nominated && entry.state === 'succeeded')) return;
        const local = stats.get(entry.localCandidateId) || {};
        const remote = stats.get(entry.remoteCandidateId) || {};
        const generatedLocal = candidateEvents.find((candidate) => (
          candidate.peerConnectionIndex === peerConnectionIndex
          && candidate.candidateType === String(local.candidateType || '')
          && candidate.protocol === String(local.protocol || '')
          && candidate.address === String(local.address || local.ip || '')
          && candidate.port === Number(local.port || 0)
        ));
        evidence.push({
          peerConnectionIndex,
          peerConnectionState: String(pc.connectionState || ''),
          pairId: String(entry.id || ''),
          selected,
          nominated: Boolean(entry.nominated),
          state: String(entry.state || ''),
          bytesSent: Number(entry.bytesSent || 0),
          bytesReceived: Number(entry.bytesReceived || 0),
          currentRoundTripTime: Number(entry.currentRoundTripTime || 0),
          local: {
            candidateType: String(local.candidateType || ''),
            protocol: String(local.protocol || ''),
            relayProtocol: String(local.relayProtocol || ''),
            address: String(local.address || local.ip || ''),
            port: Number(local.port || 0),
            turnEndpoint: parseTurnUrl(local.url) || generatedLocal?.turnEndpoint || null,
          },
          remote: {
            candidateType: String(remote.candidateType || ''),
            protocol: String(remote.protocol || ''),
            relayProtocol: String(remote.relayProtocol || ''),
            address: String(remote.address || remote.ip || ''),
            port: Number(remote.port || 0),
            url: String(remote.url || ''),
          },
        });
      });
    }
    return evidence;
  });
}

export async function expectWebMeetNetworkLane(page, {
  lane,
  publicIPv4,
  turnEndpoint = null,
  label,
  testInfo,
}) {
  let evidence = [];
  await expect.poll(async () => {
    evidence = await rtcCandidateEvidence(page);
    const active = evidence.filter((pair) => (
      pair.selected
      && pair.peerConnectionState === 'connected'
      && (pair.bytesSent > 0 || pair.bytesReceived > 0)
    ));
    if (!active.length) return false;
    const remoteIsExactLiveKitMux = (pair) => (
      pair.remote.protocol === 'udp'
      && pair.remote.address === publicIPv4
      && pair.remote.port === 7882
    );
    if (lane === 'direct-udp') {
      return active.every((pair) => (
        pair.local.candidateType !== 'relay'
        && pair.local.turnEndpoint === null
        && remoteIsExactLiveKitMux(pair)
      ));
    }
    if (lane === 'turn-udp') {
      return active.every((pair) => (
        pair.local.candidateType === 'relay'
        && pair.local.relayProtocol === 'udp'
        && remoteIsExactLiveKitMux(pair)
        && JSON.stringify(pair.local.turnEndpoint) === JSON.stringify(turnEndpoint)
      ));
    }
    if (lane === 'turn-tls') {
      return active.every((pair) => (
        pair.local.candidateType === 'relay'
        && ['tcp', 'tls'].includes(pair.local.relayProtocol)
        && remoteIsExactLiveKitMux(pair)
        && JSON.stringify(pair.local.turnEndpoint) === JSON.stringify(turnEndpoint)
      ));
    }
    return false;
  }, {
    message: `${label} must select the ${lane} candidate lane`,
    timeout: smokeConfig.timeouts.media,
  }).toBe(true);
  expect(evidence.some((pair) => pair.remote.port === 7881), `${label} must never select UDP 7881`).toBe(false);
  const probe = await page.evaluate(() => ({
    requiredTurnEndpoint: window.__e2eRequiredTurnEndpoint || null,
    rtcConfigurations: window.__e2eRtcConfigurations || [],
    generatedCandidates: window.__e2eIceCandidateEvents || [],
  }));
  await attachJsonEvidence(testInfo, `${label}-${lane}-candidate-evidence`, {
    selectedCandidatePairs: evidence,
    probe,
  });
  return evidence;
}

export function assessSelectedPairsUseLocalUdpMux(evidence, {
  requirePublicAddress = false,
  serverEvidence = null,
} = {}) {
  const active = Array.from(evidence || []).filter((pair) => (
    pair?.selected
    && (!pair.peerConnectionState || pair.peerConnectionState === 'connected')
    && (Number(pair.bytesSent || 0) > 0 || Number(pair.bytesReceived || 0) > 0)
  ));
  if (!active.length) return Object.freeze({ accepted: false, fallbackUsed: false });
  const exactServerProof = screenRuntimeEvidenceProvesUdpMux(serverEvidence);
  let fallbackUsed = false;
  const accepted = active.every((pair) => {
    if (
      pair.local?.candidateType === 'relay'
      || pair.local?.turnEndpoint !== null
      || pair.remote?.protocol !== 'udp'
    ) {
      return false;
    }
    const remoteAddress = String(pair.remote?.address || '').trim();
    const remotePort = Number(pair.remote?.port || 0);
    const hasAddress = remoteAddress.length > 0;
    if (!Number.isSafeInteger(remotePort) || remotePort < 0 || remotePort > 65_535) {
      return false;
    }
    const hasPort = Number.isSafeInteger(remotePort) && remotePort > 0;
    if (hasAddress && requirePublicAddress) {
      try {
        requirePublicIpv4(remoteAddress, 'selected LiveKit candidate address');
      } catch (_) {
        return false;
      }
    }
    if (hasPort && remotePort !== 7882) return false;
    if (hasAddress && hasPort) return true;
    if (pair.remote?.candidateType !== 'prflx' || !exactServerProof) return false;
    fallbackUsed = true;
    return true;
  });
  return Object.freeze({ accepted, fallbackUsed: accepted && fallbackUsed });
}

export function selectedPairsUseLocalUdpMux(evidence, options = {}) {
  return assessSelectedPairsUseLocalUdpMux(evidence, options).accepted;
}

async function expectLocalScreenUdpMux(page, {
  label,
  testInfo,
  screenRuntimeEvidence,
}) {
  let evidence = [];
  await expect.poll(async () => {
    evidence = await rtcCandidateEvidence(page);
    return selectedPairsUseLocalUdpMux(evidence, {
      requirePublicAddress: true,
      serverEvidence: screenRuntimeEvidence,
    });
  }, {
    message: `${label} screen traffic must use a non-relay UDP candidate pair on the fixed 7882 mux or a redacted peer-reflexive pair backed by the exact live server generation`,
    timeout: smokeConfig.timeouts.media,
  }).toBe(true);
  expect(evidence.some((pair) => pair.remote.port === 7881), `${label} must never select UDP 7881`).toBe(false);
  const assessment = assessSelectedPairsUseLocalUdpMux(evidence, {
    requirePublicAddress: true,
    serverEvidence: screenRuntimeEvidence,
  });
  const probe = await page.evaluate(() => ({
    rtcConfigurations: window.__e2eRtcConfigurations || [],
    generatedCandidates: window.__e2eIceCandidateEvents || [],
  }));
  expect(probe.rtcConfigurations.length, `${label} must create a probed RTCPeerConnection`).toBeGreaterThan(0);
  expect(probe.rtcConfigurations.every((configuration) => (
    configuration.lane === 'direct-udp'
    && configuration.iceTransportPolicy === 'all'
    && Array.isArray(configuration.iceServers)
    && configuration.iceServers.length === 0
  )), `${label} probe must remove all TURN servers`).toBe(true);
  await attachJsonEvidence(testInfo, `${label}-local-udp-7882-candidate-evidence`, {
    assertionScope: 'screen gate: observable selected remote address/port must prove globally routable non-relay UDP/7882; only redacted peer-reflexive fields may use the exact generation-bound server proof',
    serverFallbackUsed: assessment.fallbackUsed,
    screenRuntimeEvidence,
    selectedCandidatePairs: evidence,
    probe,
  });
  return evidence;
}

export async function attachJsonEvidence(testInfo, name, value) {
  const payload = JSON.stringify(value, null, 2);
  expect(findSecretLeaks(payload), `secret values leaked into ${name}`).toEqual([]);
  await testInfo.attach(name, {
    body: Buffer.from(payload, 'utf8'),
    contentType: 'application/json',
  });
}

async function joinMaterialSnapshot(page) {
  return page.evaluate(async () => {
    const dashboard = document.querySelector('webmeet-dashboard');
    const presenter = dashboard?.webSkelPresenter || null;
    const session = presenter?.state?.session || null;
    const room = presenter?.room || presenter?.roomLiveKit?.getRoom?.() || null;
    const participantToken = String(session?.participantToken || '');
    const turnExpiresAt = String(session?.turnExpiresAt || '');
    const rtcConfig = session?.rtcConfig && typeof session.rtcConfig === 'object'
      ? session.rtcConfig
      : null;
    const iceServers = Array.isArray(rtcConfig?.iceServers) ? rtcConfig.iceServers : [];
    const fingerprint = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(value)),
    )))
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
    const [participantTokenFingerprint, rtcConfigFingerprint, materialFingerprint] = await Promise.all([
      participantToken ? fingerprint(participantToken) : '',
      rtcConfig ? fingerprint(rtcConfig) : '',
      participantToken && turnExpiresAt && rtcConfig
        ? fingerprint({ participantToken, turnExpiresAt, rtcConfig })
        : '',
    ]);
    const peerConnections = Array.from(window.__e2ePeerConnections || []).map((peerConnection, index) => ({
      index,
      connectionState: String(peerConnection.connectionState || ''),
      iceConnectionState: String(peerConnection.iceConnectionState || ''),
      signalingState: String(peerConnection.signalingState || ''),
    }));
    return {
      capturedAtMs: Date.now(),
      participantIdentity: String(session?.participantIdentity || room?.localParticipant?.identity || '').trim(),
      turnExpiresAt,
      expiresAtMs: Date.parse(turnExpiresAt),
      participantTokenFingerprint,
      rtcConfigFingerprint,
      materialFingerprint,
      hasParticipantToken: Boolean(participantToken),
      iceServerCount: iceServers.length,
      everyIceServerHasCredential: iceServers.length > 0 && iceServers.every((server) => (
        Boolean(String(server?.username || '')) && Boolean(String(server?.credential || ''))
      )),
      configurationGeneration: String(session?.configurationGeneration || ''),
      publicationGeneration: String(session?.publicationGeneration || ''),
      peerConnectionCount: peerConnections.length,
      connectedPeerConnectionCount: peerConnections
        .filter((peerConnection) => peerConnection.connectionState === 'connected').length,
      peerConnections,
      roomState: String(presenter?.state?.roomState || ''),
      liveKitConnectionState: String(room?.state || ''),
    };
  });
}

function validJoinMaterialSnapshot(snapshot) {
  return Boolean(
    snapshot?.participantIdentity
    && snapshot?.hasParticipantToken
    && Number.isFinite(snapshot?.expiresAtMs)
    && Number.isFinite(snapshot?.capturedAtMs)
    && /^[0-9a-f]{64}$/.test(String(snapshot?.participantTokenFingerprint || ''))
    && /^[0-9a-f]{64}$/.test(String(snapshot?.rtcConfigFingerprint || ''))
    && /^[0-9a-f]{64}$/.test(String(snapshot?.materialFingerprint || ''))
    && snapshot?.iceServerCount > 0
    && snapshot?.everyIceServerHasCredential
    && String(snapshot?.configurationGeneration || '').trim()
    && Number.isSafeInteger(Number(snapshot?.publicationGeneration))
    && Number(snapshot?.publicationGeneration) > 0
    && snapshot?.peerConnectionCount > 0
    && Array.isArray(snapshot?.peerConnections)
    && snapshot.peerConnections.length === snapshot.peerConnectionCount
    && snapshot?.connectedPeerConnectionCount > 0
    && String(snapshot?.roomState || '').toLowerCase().startsWith('connected')
    && String(snapshot?.liveKitConnectionState || '').toLowerCase() === 'connected'
  );
}

export function newConnectedPeerConnectionIndices(before, after) {
  if (!Array.isArray(before?.peerConnections) || !Array.isArray(after?.peerConnections)) return [];
  const previous = new Map(after.peerConnections.map((row) => [row.index, row]));
  if (!before.peerConnections.every((row) => previous.get(row.index)?.connectionState === 'closed')) return [];
  return after.peerConnections
    .filter((row) => row.index >= before.peerConnectionCount && row.connectionState === 'connected')
    .map((row) => row.index);
}

export function joinMaterialAdvanced(before, after) {
  return Boolean(
    validJoinMaterialSnapshot(before)
    && validJoinMaterialSnapshot(after)
    && after.participantIdentity === before.participantIdentity
    && after.configurationGeneration === before.configurationGeneration
    && after.publicationGeneration === before.publicationGeneration
    && after.participantTokenFingerprint !== before.participantTokenFingerprint
    && after.rtcConfigFingerprint !== before.rtcConfigFingerprint
    && after.materialFingerprint !== before.materialFingerprint
    && after.expiresAtMs > before.expiresAtMs
    && after.peerConnectionCount > before.peerConnectionCount
    && newConnectedPeerConnectionIndices(before, after).length > 0
  );
}

async function snapshotJoinMaterialPages(pages) {
  return Promise.all(pages.map((page) => joinMaterialSnapshot(page)));
}

function allJoinMaterialAdvanced(before, after) {
  return before.length === after.length
    && before.every((snapshot, index) => joinMaterialAdvanced(snapshot, after[index]));
}

async function expectFreshJoinMaterial(pages, before, { label, timeout }) {
  let latest = before;
  await expect.poll(async () => {
    latest = await snapshotJoinMaterialPages(pages);
    return allJoinMaterialAdvanced(before, latest);
  }, {
    message: `${label} must disconnect, recreate, and rejoin with fresh brokered join material`,
    timeout,
    intervals: [250, 500, 1_000, 2_000],
  }).toBe(true);
  return latest;
}

async function setContextsOffline(pages, offline) {
  const contexts = [...new Set(pages.map((page) => page.context()))];
  await Promise.all(contexts.map((context) => context.setOffline(offline)));
  await expect.poll(async () => {
    const states = await Promise.all(pages.map((page) => page.evaluate(() => navigator.onLine)));
    return states.every((online) => online === !offline);
  }, {
    message: `all WebMeet browsers must report navigator.onLine=${!offline}`,
    timeout: smokeConfig.timeouts.expect,
  }).toBe(true);
}

export async function expectJoinMaterialRefreshLifecycle({
  ownerPage,
  memberPage,
  label,
  testInfo,
}) {
  const pages = [ownerPage, memberPage];
  const initial = await snapshotJoinMaterialPages(pages);
  for (const [index, snapshot] of initial.entries()) {
    expect(validJoinMaterialSnapshot(snapshot), `${label} browser ${index + 1} must expose valid non-secret join-material metadata`).toBe(true);
    const remainingMs = snapshot.expiresAtMs - Date.now();
    expect(remainingMs, `${label} browser ${index + 1} join material must retain the supported >30s lifetime`).toBeGreaterThan(30_000);
    expect(
      remainingMs,
      `${label} requires a short-lived test credential (set PLOINKY_TURN_CREDENTIAL_TTL_SECONDS=60 before starting the Box)`,
    ).toBeLessThanOrEqual(smokeConfig.timeouts.webmeetRefresh);
  }

  const originalExpiryMs = Math.max(...initial.map((snapshot) => snapshot.expiresAtMs));
  const scheduledTimeout = Math.min(
    smokeConfig.timeouts.webmeetRefresh,
    Math.max(...initial.map((snapshot) => snapshot.expiresAtMs - Date.now())),
  );
  const scheduled = await expectFreshJoinMaterial(pages, initial, {
    label: `${label} scheduled pre-expiry refresh`,
    timeout: scheduledTimeout,
  });
  expect(Date.now(), `${label} scheduled refresh must finish before the original expiry`).toBeLessThan(originalExpiryMs);

  await expect.poll(() => Date.now() > originalExpiryMs, {
    message: `${label} must outlive the original TURN credential expiry`,
    timeout: Math.max(1_000, originalExpiryMs - Date.now() + 5_000),
    intervals: [250, 500, 1_000],
  }).toBe(true);
  await expectTwoDistinctWebMeetParticipants(ownerPage, memberPage);
  const scheduledPeerConnectionIndices = scheduled.map((snapshot, index) => (
    newConnectedPeerConnectionIndices(initial[index], snapshot)
  ));
  await Promise.all([
    expectBidirectionalAudioVideoRtp(ownerPage, {
      label: `${label}-owner-after-original-expiry`, testInfo, peerConnectionIndices: scheduledPeerConnectionIndices[0],
    }),
    expectBidirectionalAudioVideoRtp(memberPage, {
      label: `${label}-member-after-original-expiry`, testInfo, peerConnectionIndices: scheduledPeerConnectionIndices[1],
    }),
  ]);

  const preTransition = await snapshotJoinMaterialPages(pages);
  const nextScheduledRefreshDeadlineMs = Math.min(...preTransition.map((snapshot) => {
    const remainingMs = snapshot.expiresAtMs - snapshot.capturedAtMs;
    const refreshLeadMs = Math.min(60_000, Math.max(10_000, Math.floor(remainingMs * 0.2)));
    return snapshot.expiresAtMs - refreshLeadMs - 5_000;
  }));
  const transitionTimeout = Math.min(15_000, nextScheduledRefreshDeadlineMs - Date.now());
  expect(
    transitionTimeout,
    `${label} needs a clean network-event refresh window before the next ordinary credential timer`,
  ).toBeGreaterThan(1_000);
  try {
    pages.forEach((page) => setPageDiagnosticsExpectedOffline(page, true));
    await setContextsOffline(pages, true);
  } finally {
    try {
      await setContextsOffline(pages, false);
    } finally {
      pages.forEach((page) => setPageDiagnosticsExpectedOffline(page, false));
    }
  }
  const transitioned = await expectFreshJoinMaterial(pages, preTransition, {
    label: `${label} forced offline/online transition`,
    timeout: transitionTimeout,
  });
  expect(Date.now(), `${label} network-event refresh must precede the next ordinary credential timer`)
    .toBeLessThan(nextScheduledRefreshDeadlineMs);
  await expectTwoDistinctWebMeetParticipants(ownerPage, memberPage);
  const transitionedPeerConnectionIndices = transitioned.map((snapshot, index) => (
    newConnectedPeerConnectionIndices(preTransition[index], snapshot)
  ));
  await Promise.all([
    expectBidirectionalAudioVideoRtp(ownerPage, {
      label: `${label}-owner-after-network-transition`, testInfo, peerConnectionIndices: transitionedPeerConnectionIndices[0],
    }),
    expectBidirectionalAudioVideoRtp(memberPage, {
      label: `${label}-member-after-network-transition`, testInfo, peerConnectionIndices: transitionedPeerConnectionIndices[1],
    }),
  ]);
  await attachJsonEvidence(testInfo, `${label}-join-material-refresh-lifecycle`, {
    assertionScope: 'two real browsers; production credential timer; original expiry outlived; forced offline/online; fresh disconnect/recreate/rejoin; post-refresh RTP',
    originalExpiryOutlived: true,
    initial,
    scheduled,
    preTransition,
    nextScheduledRefreshDeadlineMs,
    transitioned,
  });
  return { initial, scheduled, transitioned };
}

async function waitForScreenVideo(page, participantIdentity) {
  await expect.poll(async () => {
    const snapshot = await screenPublicationSnapshot(page);
    return snapshot.videos.some((video) => (
      video.participantIdentity === participantIdentity
      && video.source === SCREEN_SOURCE
      && video.trackId
      && video.trackState !== 'ended'
      && video.visible
      && video.videoWidth > 0
      && video.videoHeight > 0
      && (video.readyState >= 2 || video.currentTime > 0)
      && snapshot.remotePublications.some((publication) => (
        publication.participantIdentity === participantIdentity
        && publication.source === SCREEN_SOURCE
        && publication.publicationSid
        && publication.trackId === video.trackId
        && publication.trackPresent
        && publication.trackState !== 'ended'
      ))
      && snapshot.receivers.some((receiver) => (
        receiver.trackId === video.trackId
        && receiver.trackPresent
        && receiver.trackState !== 'ended'
      ))
    ));
  }, {
    message: `screen_share video for ${participantIdentity} must be attached, visible, and decoding`,
    timeout: smokeConfig.timeouts.media,
  }).toBe(true);
  const snapshot = await screenPublicationSnapshot(page);
  const video = snapshot.videos.find((candidate) => candidate.participantIdentity === participantIdentity);
  const publication = snapshot.remotePublications.find((candidate) => (
    candidate.participantIdentity === participantIdentity
    && candidate.trackId === video?.trackId
  ));
  return {
    ...video,
    publicationSid: publication?.publicationSid || '',
    receiverPeerConnectionIndices: snapshot.receivers
      .filter((receiver) => receiver.trackId === video?.trackId)
      .map((receiver) => receiver.peerConnectionIndex),
  };
}

async function expectExactTrackRtpGrowth(page, direction, trackId, before) {
  let latest = before;
  await expect.poll(async () => {
    latest = await exactTrackRtpSnapshot(page, { direction, trackId });
    return latest.rows.length > 0
      && latest.packets > before.packets
      && latest.frames > before.frames;
  }, {
    message: `${direction} screen RTP packets and frames must increase for exact track ${trackId}`,
    timeout: smokeConfig.timeouts.media,
    intervals: [250, 500, 1_000],
  }).toBe(true);
  return latest;
}

export async function exerciseScreenShareDirection({
  sharerPage,
  receiverPage,
  sharerIdentity,
  receiverIdentity,
  label,
  testInfo,
  screenRuntimeEvidence,
}) {
  const screenButton = sharerPage.locator('#webmeetScreenShareButton');
  await expect(screenButton).toBeEnabled();
  await screenButton.click();
  await expect(screenButton).toHaveClass(/\bactive\b/, { timeout: smokeConfig.timeouts.media });

  await expect.poll(async () => {
    const snapshot = await screenPublicationSnapshot(sharerPage);
    return snapshot.buttonActive
      && snapshot.localIdentity === sharerIdentity
      && snapshot.publications.some((publication) => (
        publication.source === SCREEN_SOURCE
        && publication.participantIdentity === sharerIdentity
        && publication.publicationSid
        && publication.trackId
        && !publication.muted
        && publication.trackState !== 'ended'
      ));
  }, {
    message: `${label} must publish a real local LiveKit ScreenShare track`,
    timeout: smokeConfig.timeouts.media,
  }).toBe(true);

  const localSnapshot = await screenPublicationSnapshot(sharerPage);
  const localPublication = localSnapshot.publications.find((publication) => publication.source === SCREEN_SOURCE);
  expect(localPublication?.participantIdentity).toBe(sharerIdentity);
  const remoteVideo = await waitForScreenVideo(receiverPage, sharerIdentity);
  expect(remoteVideo?.participantIdentity).toBe(sharerIdentity);

  const [outboundBefore, inboundBefore] = await Promise.all([
    exactTrackRtpSnapshot(sharerPage, { direction: 'outbound', trackId: localPublication.trackId }),
    exactTrackRtpSnapshot(receiverPage, { direction: 'inbound', trackId: remoteVideo.trackId }),
  ]);
  const [outboundAfter, inboundAfter] = await Promise.all([
    expectExactTrackRtpGrowth(sharerPage, 'outbound', localPublication.trackId, outboundBefore),
    expectExactTrackRtpGrowth(receiverPage, 'inbound', remoteVideo.trackId, inboundBefore),
  ]);
  const [sharerCandidatePairs, receiverCandidatePairs] = await Promise.all([
    expectLocalScreenUdpMux(sharerPage, {
      label: `${label}-sharer`, testInfo, screenRuntimeEvidence,
    }),
    expectLocalScreenUdpMux(receiverPage, {
      label: `${label}-receiver`, testInfo, screenRuntimeEvidence,
    }),
  ]);

  const evidence = {
    label,
    sharerIdentity,
    receiverIdentity,
    local: {
      publication: localPublication,
      rtpBefore: outboundBefore,
      rtpAfter: outboundAfter,
      candidates: sharerCandidatePairs,
    },
    remote: {
      video: remoteVideo,
      rtpBefore: inboundBefore,
      rtpAfter: inboundAfter,
      candidates: receiverCandidatePairs,
    },
  };
  await attachJsonEvidence(testInfo, `${label}-screen-share-rtc`, evidence);

  await screenButton.click();
  await expect(screenButton).not.toHaveClass(/\bactive\b/, { timeout: smokeConfig.timeouts.media });
  await expect.poll(async () => {
    const snapshot = await screenPublicationSnapshot(sharerPage);
    return snapshot.publications.length === 0 && snapshot.videos.length === 0;
  }, {
    message: `${label} must unpublish and remove the local ScreenShare track`,
    timeout: smokeConfig.timeouts.media,
  }).toBe(true);
  await expect.poll(async () => {
    const snapshot = await screenPublicationSnapshot(receiverPage);
    return exactRemoteScreenTrackStopped(snapshot, {
      participantIdentity: sharerIdentity,
      publicationSid: remoteVideo.publicationSid,
      trackId: remoteVideo.trackId,
    });
  }, {
    message: `${label} remote ScreenShare track must be removed or stopped before reversing direction`,
    timeout: smokeConfig.timeouts.media,
  }).toBe(true);
  const stoppedRemoteSnapshot = await screenPublicationSnapshot(receiverPage);
  await attachJsonEvidence(testInfo, `${label}-screen-share-stopped`, {
    reference: {
      participantIdentity: sharerIdentity,
      publicationSid: remoteVideo.publicationSid,
      trackId: remoteVideo.trackId,
    },
    matchingPublications: stoppedRemoteSnapshot.remotePublications.filter((publication) => (
      publication.participantIdentity === sharerIdentity
      && (publication.publicationSid === remoteVideo.publicationSid || publication.trackId === remoteVideo.trackId)
    )),
    matchingReceivers: stoppedRemoteSnapshot.receivers.filter((receiver) => receiver.trackId === remoteVideo.trackId),
    matchingVideos: stoppedRemoteSnapshot.videos.filter((video) => (
      video.trackId === remoteVideo.trackId || video.participantIdentity === sharerIdentity
    )),
  });
}

export async function attachFinalWebMeetRtcEvidence(page, testInfo, label) {
  const evidence = {
    participants: await participantSnapshot(page),
    screen: await screenPublicationSnapshot(page),
    selectedCandidatePairs: await rtcCandidateEvidence(page),
  };
  await attachJsonEvidence(testInfo, `${label}-final-rtc`, evidence);
}
