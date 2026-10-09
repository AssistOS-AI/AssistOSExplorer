import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { WebMeetParticipantCard } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-participant-card/webmeet-participant-card.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const layoutControllerPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/participant-layout-controller.js'
);
const participantCardPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-participant-card/webmeet-participant-card.js'
);
const roomSessionMethodsPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/room-session-methods.js'
);
const dashboardModalPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.js'
);

test('participant layout controller persists avatar config and fallback attributes for late presenter init', async () => {
    const source = await fs.readFile(layoutControllerPath, 'utf8');

    assert.match(source, /applyParticipantProfileAvatar/);
    assert.match(source, /participant\?\.profileAvatar/);
    assert.match(source, /const avatarProjection = this\.applyParticipantProfileAvatar\(view, participant\)/);
    assert.doesNotMatch(source, /participant\?\.kind === 'local' && !avatarProjection/);
    assert.doesNotMatch(source, /profileAvatarController\.refresh\(view, participant/);
    assert.doesNotMatch(source, /const shouldUseProjectedAvatar = participant\?\.kind !== 'local'/);
    assert.match(source, /view\.avatarSource = 'projected'/);
    assert.match(source, /filter\(\(view\) => view\.avatarSource !== 'projected'\)/);
    assert.match(source, /applyParticipantAvatarState\(view\)/);
    assert.match(source, /data-avatar-config/);
    assert.match(source, /data-avatar-fallback-letter/);
    assert.match(source, /data-avatar-size/);
    assert.match(source, /JSON\.stringify\(payload\.avatarConfig\)/);
});

test('participant layout controller preserves projected avatars during media-only participant updates', async () => {
    const source = await fs.readFile(layoutControllerPath, 'utf8');

    assert.match(source, /avatarProjection\.projected/);
    assert.match(source, /avatarProjection\.changed/);
    assert.match(source, /view\.avatarSource === 'projected' && view\.avatarConfig/);
    assert.doesNotMatch(source, /profileAvatarController\.refresh\(view, participant/);
});

test('participant card updates avatar through a dedicated avatar state channel', async () => {
    const cardSource = await fs.readFile(participantCardPath, 'utf8');
    const layoutSource = await fs.readFile(layoutControllerPath, 'utf8');
    const applyStateBody = cardSource.slice(
        cardSource.indexOf('    applyState() {'),
        cardSource.indexOf('\n    applyAvatarState() {')
    );

    assert.match(cardSource, /setAvatarState\(patch = \{\}\)/);
    assert.match(cardSource, /applyAvatarState\(\)/);
    assert.doesNotMatch(applyStateBody, /renderAvatar\(initials\)/);
    assert.match(layoutSource, /presenter\.setAvatarState\(payload\)/);
});

test('participant card updates runtime emotion without rebuilding axi-face', () => {
    const emotionUpdates = [];
    const axiFace = {
        dataset: {},
        style: {
            setProperty(name, value) {
                this[name] = value;
            }
        },
        setEmotion(emotion, options) {
            emotionUpdates.push({ emotion, options });
        }
    };
    const avatarHost = {
        dataset: {},
        querySelector(selector) {
            return selector === 'axi-face' ? axiFace : null;
        }
    };
    const card = Object.create(WebMeetParticipantCard.prototype);
    card.refs = { avatar: avatarHost };
    card.state = {
        displayName: 'Local User',
        avatarResolved: true,
        avatarEnabled: true,
        avatarConfig: {
            size: '72',
            emotion: 'neutral',
            packSrc: '/packs/emoji-black/manifest.json'
        },
        avatarRuntimeState: {
            emotion: 'happy',
            intensity: 0.8,
            speaking: true
        },
        avatarFallbackLetter: 'L',
        isMini: false
    };
    const key = `axi:72px:${JSON.stringify(card.state.avatarConfig)}`;
    card.avatarRenderKey = key;
    avatarHost.dataset.avatarRenderKey = key;

    card.renderAvatar('LU');
    card.state.avatarRuntimeState = {
        ...card.state.avatarRuntimeState,
        intensity: 0.9
    };
    card.renderAvatar('LU');

    assert.deepEqual(emotionUpdates, [{ emotion: 'happy', options: { intensity: 0.8 } }]);
    assert.equal(axiFace.style['--axi-face-intensity'], '0.9');
    assert.equal(card.avatarRenderKey, key);
});

test('dashboard primes the active local avatar before LiveKit renders participant cards', async () => {
    const actionSource = await fs.readFile(path.join(
        repoRoot,
        'IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/meeting-action-methods.js'
    ), 'utf8');
    const participantSource = await fs.readFile(path.join(
        repoRoot,
        'IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/participant-view-methods.js'
    ), 'utf8');

    assert.match(actionSource, /await this\.webMeetRoom\.join\(payload, transition\);/);
    assert.match(actionSource, /await this\.primeCurrentParticipantAvatarProjection\(\{ force: true \}\);/);
    assert.match(actionSource, /async primeCurrentParticipantAvatarProjection\(options = \{\}\)/);
    assert.match(actionSource, /this\.setRoomAvatar\(participantId, resolved\.avatar\)/);
    assert.match(actionSource, /profileAvatar: resolved\.avatar/);
    assert.match(actionSource, /if \(!profileAvatar && override\)/);
    assert.match(participantSource, /const profileAvatar = normalizeProfileAvatar\(participant\?\.profileAvatar\)\s+\|\| getRoomAvatarFor\(this, participantId\)/);
    assert.match(participantSource, /this\.webMeetRoom\.buildAvatarProjection\(localSourceAvatar, localIdentity\)/);
});

test('participant layout controller clears stale video elements when video state becomes empty', async () => {
    const source = await fs.readFile(layoutControllerPath, 'utf8');

    assert.match(source, /const videoElements = this\.getParticipantVideoElements\(view\)/);
    assert.match(source, /presenter\.setVideoElements\(videoElements\)/);
    assert.match(source, /presenter\.setVideoElement\(videoElements\[0\] \|\| null\)/);
    assert.match(source, /clearParticipantVideoSources\(participantId, sources = \[\]\)/);
    assert.match(source, /mediaElement\.remove\(\)/);
    assert.match(source, /this\.renderParticipantLayout\(\)/);
});

test('dashboard clears local camera and screen video elements when local media state turns off', async () => {
    const source = await fs.readFile(dashboardModalPath, 'utf8');

    assert.match(source, /onMediaStateChange: \(next, localParticipantId\) =>/);
    assert.match(source, /if \(!next\.camera\)/);
    assert.match(source, /clearParticipantVideoSources\(localParticipantId, \[/);
    assert.match(source, /Track\?\.Source\?\.Camera/);
    assert.match(source, /if \(!next\.screen\)/);
    assert.match(source, /Track\?\.Source\?\.ScreenShare/);
});

test('room session treats camera and screen-share sources as video when unpublish event lacks kind', async () => {
    const source = await fs.readFile(roomSessionMethodsPath, 'utf8');

    assert.match(source, /Track\.Source\?\.Camera/);
    assert.match(source, /Track\.Source\?\.ScreenShare/);
    assert.match(source, /rawKind === 'video' \|\| isVideoSource \? 'video'/);
    assert.match(source, /findTrackIdsForParticipant\(participantId, \{\s+kind: publicationKind,\s+source/s);
});

test('participant card restores avatar config and fallback letter from element attributes', async () => {
    const source = await fs.readFile(participantCardPath, 'utf8');

    assert.match(source, /ensureAxiFaceLoaded/);
    assert.match(source, /function parseAvatarConfig/);
    assert.match(source, /data-avatar-config/);
    assert.match(source, /data-avatar-fallback-letter/);
    assert.match(source, /avatarConfig:\s*parseAvatarConfig\(element\.getAttribute\('data-avatar-config'\)\)/);
    assert.match(source, /avatarFallbackLetter:\s*String\(element\.getAttribute\('data-avatar-fallback-letter'\) \|\| ''\)\.trim\(\)/);
    assert.match(source, /dataset\.avatarSize = size/);
});

test('participant card preserves pending video elements and ignores conclusively ended tracks', async () => {
    const source = await fs.readFile(participantCardPath, 'utf8');

    assert.match(source, /function hasOnlyEndedVideoTracks\(mediaElement\)/);
    assert.match(source, /getVideoTracks/);
    assert.match(source, /readyState \|\| ''\)\.trim\(\) === 'ended'/);
    assert.match(source, /const candidateElements = Array\.from\(mediaElements\)\.filter\(Boolean\)/);
    assert.match(source, /const nextElements = candidateElements\.filter\(\(element\) => !hasOnlyEndedVideoTracks\(element\)\)/);
    assert.match(source, /cleanupVideoElement\(element\)/);
    assert.match(source, /hasVideo: nextElements\.length > 0/);

    const createCard = () => {
        const card = Object.create(WebMeetParticipantCard.prototype);
        card.element = { style: { removeProperty() {} } };
        card.refs = null;
        card.mediaElement = null;
        card.mediaElements = [];
        card.mediaAspectCleanup = null;
        card.state = {};
        return card;
    };
    const createVideo = (tracks) => {
        let removed = false;
        return {
            srcObject: { getVideoTracks: () => tracks },
            addEventListener() {},
            removeEventListener() {},
            remove() { removed = true; },
            get removed() { return removed; }
        };
    };

    const pendingCard = createCard();
    const pendingVideo = createVideo([]);
    pendingCard.setVideoElements([pendingVideo]);
    assert.deepEqual(pendingCard.mediaElements, [pendingVideo]);
    assert.equal(pendingVideo.removed, false);

    const endedCard = createCard();
    const endedVideo = createVideo([{ readyState: 'ended' }]);
    endedCard.setVideoElements([endedVideo]);
    assert.deepEqual(endedCard.mediaElements, []);
    assert.equal(endedVideo.removed, true);
});

test('WebMeet registers participant cards before dashboard data can create them', async () => {
    const source = await fs.readFile(dashboardModalPath, 'utf8');

    assert.match(source, /async function ensureParticipantCardRegistered\(\)/);
    assert.match(source, /ensureComponentRegistered\(componentName\)/);
    assert.match(source, /registration did not complete/);
    assert.match(source, /async beforeRender\(\) \{\s*await ensureParticipantCardRegistered\(\);/);
});

test('participant card keeps fallback initials until axi-face is registered', async () => {
    const source = await fs.readFile(participantCardPath, 'utf8');

    assert.match(source, /!customElements\.get\('axi-face'\)/);
    assert.match(source, /this\.refs\.avatar\.textContent = fallback/);
    assert.match(source, /ensureAxiFaceLoaded\(\)/);
    assert.match(source, /avatarLoadFailedKey/);
    assert.match(source, /this\.avatarLoadFailedKey === loadKey/);
    assert.match(source, /this\.avatarRenderKey = ''/);
    assert.match(source, /this\.applyState\(\)/);
});

test('participant card verifies avatar DOM before skipping rerender', async () => {
    const source = await fs.readFile(participantCardPath, 'utf8');

    assert.match(source, /function isAvatarRenderCurrent\(avatarElement, key, options = \{\}\)/);
    assert.match(source, /avatarElement\.dataset\.avatarRenderKey !== key/);
    assert.match(source, /querySelector\('axi-face'\)/);
    assert.match(source, /requiresAxiFace: true/);
    assert.match(source, /this\.refs\.avatar\.dataset\.avatarRenderKey = key/);
    assert.doesNotMatch(source, /if \(this\.avatarRenderKey === key\) return;/);
});
