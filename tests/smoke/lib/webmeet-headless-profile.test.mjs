import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { validateHeadlessWebMeetProfile } from './webmeet-headless-profile.mjs';

test('headless WebMeet profile requires synthetic media and excludes headed screen capture', () => {
  assert.deepEqual(validateHeadlessWebMeetProfile({
    enabled: true,
    headed: false,
    media: true,
    screen: false,
  }), {
    enabled: true,
    headed: false,
    media: true,
    screen: false,
  });
  assert.throws(
    () => validateHeadlessWebMeetProfile({
      enabled: true, headed: true, media: true, screen: false,
    }),
    /forbids headed/,
  );
  assert.throws(
    () => validateHeadlessWebMeetProfile({
      enabled: true, headed: false, media: true, screen: true,
    }),
    /excludes the opt-in screen-sharing gate/,
  );
  assert.throws(
    () => validateHeadlessWebMeetProfile({
      enabled: true, headed: false, media: false, screen: false,
    }),
    /requires SMOKE_WEBMEET_MEDIA=1/,
  );
});

test('npm headless WebMeet profile selects only the automated WebMeet acceptance specs', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const command = packageJson.scripts?.['test:webmeet-headless'];
  assert.equal(typeof command, 'string');
  assert.match(command, /\bSMOKE_WEBMEET_HEADLESS=1\b/);
  assert.match(command, /\bSMOKE_WEBMEET_MEDIA=1\b/);
  assert.match(command, /\bspecs\/30-webmeet-room-chat\.spec\.mjs\b/);
  assert.match(command, /\bspecs\/31-webmeet-settings\.spec\.mjs\b/);
  assert.match(command, /\bspecs\/40-webmeet-tagged-research\.spec\.mjs\b/);
  assert.doesNotMatch(command, /SMOKE_WEBMEET_SCREEN|--headed|specs\/(?:00|10|15|20|32|33|34|50|60|61|70)-/);

  const fullCommand = packageJson.scripts?.['test:full'];
  assert.match(fullCommand, /\bSMOKE_WEBMEET_HEADLESS=1\b/);
  assert.doesNotMatch(fullCommand, /SMOKE_WEBMEET_SCREEN|--headed/);

  const screenCommand = packageJson.scripts?.['test:webmeet-screen'];
  assert.match(screenCommand, /\bSMOKE_WEBMEET_SCREEN=1\b/);
  assert.match(screenCommand, /--headed/);
  assert.match(screenCommand, /\bspecs\/30-webmeet-room-chat\.spec\.mjs\b/);
  assert.doesNotMatch(screenCommand, /\bspecs\/(?:00|10|15|20|31|32|33|34|40|50|60|61|70)-/);
});

test('headless WebMeet acceptance keeps synthetic media, strict accounts, and four-direction RTP', () => {
  const playwrightConfig = fs.readFileSync(new URL('../playwright.config.mjs', import.meta.url), 'utf8');
  assert.match(playwrightConfig, /--use-fake-ui-for-media-stream/);
  assert.match(playwrightConfig, /--use-fake-device-for-media-stream/);

  const roomSpec = fs.readFileSync(new URL('../specs/30-webmeet-room-chat.spec.mjs', import.meta.url), 'utf8');
  assert.match(roomSpec, /smokeConfig\.flags\.webmeetHeadless/);
  assert.doesNotMatch(roomSpec, /['"]\/dashboard['"]/, 'WebMeet auth seeding must use an admitted Explorer route');
  assert.equal(
    [...roomSpec.matchAll(/explorerUrl\(\)/g)].length,
    2,
    'only the strict storage-state auth seeds should use the admitted Explorer route',
  );
  assert.match(
    roomSpec,
    /trySignInToWebMeet\(memberPage, smokeConfig\.secondaryUser\)/,
    'the fallback member must authenticate directly into WebMeet instead of booting and abandoning Explorer',
  );
  assert.match(roomSpec, /await expectWebMeetReady\(memberPage, \{ expectCreateRoom: false \}\)/);
  assert.match(roomSpec, /requireConfiguredPrincipal:\s*true/);
  assert.match(roomSpec, /assertDistinctAuthenticatedPrincipals\(ownerPrincipal,\s*memberPrincipal\)/);
  assert.match(roomSpec, /expectBidirectionalAudioVideoRtp\(ownerPage/);
  assert.match(roomSpec, /expectBidirectionalAudioVideoRtp\(memberPage/);
  assert.match(roomSpec, /expectWebMeetMediaState\(ownerPage/);
  assert.match(roomSpec, /expectWebMeetMediaState\(memberPage/);
  const webMeetHelpers = fs.readFileSync(new URL('./webmeet.mjs', import.meta.url), 'utf8');
  assert.match(
    webMeetHelpers,
    /return trySignIn\(page, account, webMeetDashboardPath\(\)\)/,
    'the optional-account path must use the same direct destination as strict WebMeet navigation',
  );
  assert.match(
    webMeetHelpers,
    /'outbound-rtp:audio'[\s\S]*'outbound-rtp:video'[\s\S]*'inbound-rtp:audio'[\s\S]*'inbound-rtp:video'/,
  );
  assert.match(webMeetHelpers, /entry\.type !== 'data-channel'/);
  assert.match(webMeetHelpers, /#webmeetVideoGrid webmeet-participant-card video/);
  assert.match(webMeetHelpers, /publication\.trackPresent/);
  assert.match(webMeetHelpers, /openChannelLabels[\s\S]*includes\('reliable'\)[\s\S]*includes\('lossy'\)/);
});

test('two-account cleanup preserves final evidence and closes the member before owner deletion', () => {
  const roomSpec = fs.readFileSync(new URL('../specs/30-webmeet-room-chat.spec.mjs', import.meta.url), 'utf8');
  const finalMemberRtc = roomSpec.indexOf("'secondary WebMeet final RTC evidence'");
  const memberClose = roomSpec.indexOf("'secondary WebMeet context close before room deletion'");
  const roomDeletion = roomSpec.indexOf("'WebMeet room deletion'");
  const ownerClose = roomSpec.indexOf("'primary WebMeet context close'");

  assert.ok(finalMemberRtc >= 0, 'secondary final RTC evidence must remain mandatory');
  assert.ok(memberClose > finalMemberRtc, 'the member context must stay live through final RTC capture');
  assert.ok(roomDeletion > memberClose, 'the member context must close before exact room deletion');
  assert.ok(ownerClose > roomDeletion, 'the authenticated owner context must stay live through room deletion');
});
