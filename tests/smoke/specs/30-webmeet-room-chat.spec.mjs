import { test, expect, attachPageDiagnostics, installRtcProbe } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import {
  assertDistinctAuthenticatedPrincipals,
  normalizePrincipalComponent,
  signIn,
} from '../lib/auth.mjs';
import { stopAndAttachRedactedTrace } from '../lib/redacted-trace.mjs';
import { createReleaseGateFailureCollector } from '../lib/release-gate-failures.mjs';
import { explorerUrl } from '../lib/explorer.mjs';
import { readExpectedGpuGrant } from '../lib/box-evidence.mjs';
import {
  collectScreenRuntimeEvidence,
  sameScreenRuntimeGeneration,
  validateScreenRuntimeEvidence,
} from '../lib/screen-runtime-evidence.mjs';
import {
  attachJsonEvidence,
  attachFinalWebMeetRtcEvidence,
  createRoom,
  deleteRoomIfPresent,
  enableMedia,
  expectAuthenticatedStandaloneWebMeet,
  expectChatEntry,
  expectGuestVisibleToOwner,
  expectBidirectionalAudioVideoRtp,
  expectWebMeetMediaState,
  expectWebMeetReady,
  expectIncreasingRtpStats,
  expectJoinMaterialRefreshLifecycle,
  expectTwoDistinctWebMeetParticipants,
  exerciseScreenShareDirection,
  joinStandaloneGuestRoom,
  joinRoom,
  openStandaloneWebMeet,
  openWebMeet,
  readRoomShareLink,
  sendWebMeetChat,
  trySignInToWebMeet,
} from '../lib/webmeet.mjs';
import {
  PUBLIC_ROOM_DENIED_MESSAGE,
  describeGuestCookies,
  forbiddenGuestAdmissionTools,
  mcpToolNamesFromPostData,
  publicRoomLoaderUrl,
} from '../lib/webmeet-public-room.mjs';

function expectNoUnfilteredBrowserErrors(diagnostics, label) {
  expect(diagnostics.events.filter((event) => (
    event.kind === 'pageerror' || (event.kind === 'console' && event.type === 'error')
  )), `${label} must have zero browser errors, including cleanup`).toEqual([]);
}

test.describe('WebMeet rooms', () => {
  test('standalone loader serves the authenticated dashboard and a guest invitation', async ({ page, browser }, testInfo) => {
    // Public-room release gate: anyone holding the URL of a public room can join
    // it and chat with its owner, and the URL of a team room is refused.
    test.setTimeout(Math.max(smokeConfig.timeouts.test, 300_000));
    const publicTitle = `e2e-public-room-${smokeConfig.runId}`;
    const teamTitle = `e2e-team-room-${smokeConfig.runId}`;
    const guestDisplayName = `e2e-guest-${smokeConfig.runId}`;
    const ownerMessage = `public-chat-from-owner-${smokeConfig.runId}`;
    const guestMessage = `public-chat-from-guest-${smokeConfig.runId}`;
    const ownerDiagnostics = attachPageDiagnostics(page, testInfo, 'webmeet-standalone-owner');
    const guestContext = await browser.newContext({
      baseURL: smokeConfig.baseURL,
      ignoreHTTPSErrors: true,
    });
    const guestPage = await guestContext.newPage();
    const guestDiagnostics = attachPageDiagnostics(guestPage, testInfo, 'webmeet-standalone-guest');
    const deniedContext = await browser.newContext({
      baseURL: smokeConfig.baseURL,
      ignoreHTTPSErrors: true,
    });
    const deniedPage = await deniedContext.newPage();
    const deniedDiagnostics = attachPageDiagnostics(deniedPage, testInfo, 'webmeet-standalone-denied');
    let publicRoomCreated = false;
    let teamRoomCreated = false;
    let primaryError = null;
    const failureCollector = createReleaseGateFailureCollector();

    try {
      await openWebMeet(page);
      await deleteRoomIfPresent(page, publicTitle);
      await deleteRoomIfPresent(page, teamTitle);
      publicRoomCreated = true;
      const publicRoomId = await createRoom(page, publicTitle, { roomType: 'guest' });
      teamRoomCreated = true;
      const teamRoomId = await createRoom(page, teamTitle, { roomType: 'team' });
      expect(teamRoomId, 'the public and team rooms must be distinct rooms').not.toBe(publicRoomId);

      // The links are taken from the WebMeet UI, exactly as the owner would copy them.
      const publicRoomUrl = await readRoomShareLink(page, publicTitle);
      const teamRoomUrl = await readRoomShareLink(page, teamTitle);
      expect(publicRoomUrl, 'the UI share link of the public room').toBe(publicRoomLoaderUrl(smokeConfig.baseURL, publicRoomId));
      expect(teamRoomUrl, 'the UI share link of the team room').toBe(publicRoomLoaderUrl(smokeConfig.baseURL, teamRoomId));

      await expectAuthenticatedStandaloneWebMeet(page);
      await openWebMeet(page);
      await joinRoom(page, publicTitle);

      // Positive proof: a guest context with no cookies, storage or sign-in
      // opens only the public URL, gives a name, and exchanges chat both ways.
      expect(await guestContext.storageState(), 'the guest context must start with no cookies or storage').toEqual({ cookies: [], origins: [] });
      const guestNavigations = [];
      guestPage.on('framenavigated', (frame) => {
        if (frame === guestPage.mainFrame()) guestNavigations.push(frame.url());
      });
      await joinStandaloneGuestRoom(guestPage, { url: publicRoomUrl, displayName: guestDisplayName });
      expect(guestNavigations.filter((url) => new URL(url).pathname.startsWith('/auth/')),
        'the guest must never be sent to or through sign-in').toEqual([]);
      const joinedUrl = new URL(guestPage.url());
      expect([joinedUrl.pathname, joinedUrl.searchParams.get('roomId')], 'the guest stays on the public room URL')
        .toEqual(['/webmeetAgent/roomLoader.html', publicRoomId]);
      const guestCookies = describeGuestCookies(await guestContext.cookies());
      expect(guestCookies.hasGuestSession, `the router must give the guest a guest session (cookies: ${guestCookies.names.join(', ')})`).toBe(true);
      expect(guestCookies.signedInCookies, 'the guest must hold no signed-in session').toEqual([]);

      await expectGuestVisibleToOwner(page, guestPage, guestDisplayName);

      await sendWebMeetChat(guestPage, guestMessage);
      await expectChatEntry(page, guestMessage, { author: guestDisplayName });
      await sendWebMeetChat(page, ownerMessage);
      await expectChatEntry(guestPage, ownerMessage);

      // Negative control: the same kind of link for a team room is refused.
      expect(await deniedContext.storageState(), 'the denied-visitor context must start with no cookies or storage').toEqual({ cookies: [], origins: [] });
      const deniedToolCalls = [];
      deniedPage.on('request', (request) => {
        if (request.method() === 'POST') deniedToolCalls.push(...mcpToolNamesFromPostData(request.postData()));
      });
      const publicGetResponse = deniedPage.waitForResponse((response) => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/webmeetAgent/mcp'
        && mcpToolNamesFromPostData(response.request().postData()).includes('webmeet_room_public_get')
      ));
      publicGetResponse.catch(() => {});
      await openStandaloneWebMeet(deniedPage, { url: teamRoomUrl });
      const denial = deniedPage.locator('.webmeet-access-denied[role="alert"]');
      await expect(denial).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
      await expect(denial.locator('h1')).toHaveText('Authentication required');
      await expect(denial.locator('p')).toHaveText(PUBLIC_ROOM_DENIED_MESSAGE);
      await expect(denial.locator('a.webmeet-login-link')).toHaveAttribute(
        'href',
        `/auth/login?${new URLSearchParams({ returnTo: `/webmeetAgent/roomLoader.html?roomId=${teamRoomId}` })}`,
      );
      expect(await (await publicGetResponse).text(), 'WebMeet itself must report that the room is not public').toContain('Public room not found.');
      await expect(deniedPage.locator('#webmeetGuestEntryName')).toHaveCount(0);
      await expect(deniedPage.locator('#webmeetChatInput')).toHaveCount(0);
      await expect(deniedPage.locator('div.webmeet-dashboard')).toHaveCount(0);
      expect(deniedToolCalls, 'the refused visitor must have asked WebMeet about the room').toContain('webmeet_room_public_get');
      expect(forbiddenGuestAdmissionTools(deniedToolCalls), 'the refused visitor must never be admitted or post').toEqual([]);
      expect(describeGuestCookies(await deniedContext.cookies()).signedInCookies, 'the refused visitor must hold no signed-in session').toEqual([]);

      if (smokeConfig.flags.failOnBrowserErrors) {
        expect(ownerDiagnostics.actionableEvents(), 'standalone owner browser errors').toEqual([]);
        expect(guestDiagnostics.actionableEvents(), 'standalone guest browser errors').toEqual([]);
        expect(deniedDiagnostics.actionableEvents(), 'refused team-room visitor browser errors').toEqual([]);
      }
    } catch (error) {
      primaryError = error;
      await Promise.all([
        failureCollector.required('standalone owner failure screenshot', () => (
          page.screenshot({
            path: testInfo.outputPath('webmeet-standalone-owner-failure.png'),
            fullPage: true,
          })
        )),
        failureCollector.required('standalone guest failure screenshot', () => (
          guestPage.screenshot({
            path: testInfo.outputPath('webmeet-standalone-guest-failure.png'),
            fullPage: true,
          })
        )),
        failureCollector.required('standalone refused visitor failure screenshot', () => (
          deniedPage.screenshot({
            path: testInfo.outputPath('webmeet-standalone-denied-failure.png'),
            fullPage: true,
          })
        )),
      ]);
    } finally {
      if ((publicRoomCreated || teamRoomCreated) && !page.isClosed()) {
        await failureCollector.required('standalone run-scoped room deletion', async () => {
          await openWebMeet(page);
          await deleteRoomIfPresent(page, publicTitle);
          await deleteRoomIfPresent(page, teamTitle);
        });
      }
      await Promise.all([
        failureCollector.required('standalone owner diagnostics', () => ownerDiagnostics.flush()),
        failureCollector.required('standalone guest diagnostics', () => guestDiagnostics.flush()),
        failureCollector.required('standalone refused visitor diagnostics', () => deniedDiagnostics.flush()),
        failureCollector.required('standalone guest context close', () => guestContext.close()),
        failureCollector.required('standalone refused visitor context close', () => deniedContext.close()),
      ]);
    }
    failureCollector.throwIfAny({ primaryError, label: 'standalone WebMeet gate' });
  });

  test('two Explorer accounts can join one room and exchange chat', async ({ page, browser }, testInfo) => {
    test.setTimeout(smokeConfig.flags.webmeetRefresh
      ? Math.max(smokeConfig.timeouts.test, (smokeConfig.timeouts.webmeetRefresh * 2) + 180_000)
      : smokeConfig.timeouts.test);
    const roomTitle = `e2e-room-${smokeConfig.runId}`;
    const ownerMessage = `chat-from-owner-${smokeConfig.runId}`;
    const memberMessage = `chat-from-member-${smokeConfig.runId}`;
    let ownerContext = null;
    let ownerPage = page;
    let ownerDiagnostics = null;
    let seedDiagnostics = null;
    let seedTraceStarted = false;
    let ownerTraceStarted = false;
    let memberContext = null;
    let memberPage = null;
    let memberDiagnostics = null;
    let memberTraceStarted = false;
    let identities = null;
    let authenticatedPrincipals = null;
    let roomCreationAttempted = false;
    let primaryError = null;
    let screenRuntimeEvidence = null;
    const failureCollector = createReleaseGateFailureCollector();

    try {
      if (
        smokeConfig.flags.webmeetHeadless
        || smokeConfig.flags.webmeetScreen
        || smokeConfig.flags.webmeetRefresh
      ) {
        expect(
          smokeConfig.flags.failOnBrowserErrors,
          'SMOKE_ALLOW_BROWSER_ERRORS is forbidden for WebMeet headless/screen/refresh release gates',
        ).toBe(true);
        expect(smokeConfig.primaryUser.username, 'primary smoke username must be configured').toBeTruthy();
        expect(smokeConfig.secondaryUser.username, 'secondary smoke username must be configured').toBeTruthy();
        expect(
          normalizePrincipalComponent(smokeConfig.secondaryUser.username, 'secondary configured account username'),
          'WebMeet release gates require two distinct normalized configured account usernames',
        ).not.toBe(normalizePrincipalComponent(smokeConfig.primaryUser.username, 'primary configured account username'));
        if (
          smokeConfig.flags.webmeetRefresh
          && !smokeConfig.flags.webmeetScreen
          && !smokeConfig.flags.webmeetHeadless
        ) {
          ownerDiagnostics = attachPageDiagnostics(ownerPage, testInfo, 'webmeet-primary-refresh');
        }
      }

      if (smokeConfig.flags.webmeetScreen) {
        const serializedRuntimeEvidence = String(process.env.SMOKE_SCREEN_RUNTIME_EVIDENCE || '').trim();
        if (!serializedRuntimeEvidence) {
          throw new Error('SMOKE_WEBMEET_SCREEN requires live deployment evidence from scripts/run-playwright.mjs.');
        }
        try {
          screenRuntimeEvidence = validateScreenRuntimeEvidence(JSON.parse(serializedRuntimeEvidence), {
            baseURL: smokeConfig.baseURL,
            expectedGpuGrant: readExpectedGpuGrant(),
          });
        } catch (error) {
          throw new Error(`SMOKE_WEBMEET_SCREEN deployment evidence is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
        await attachJsonEvidence(testInfo, 'screen-runtime-evidence', screenRuntimeEvidence);
      }

      if (smokeConfig.flags.webmeetScreen || smokeConfig.flags.webmeetHeadless) {
        seedDiagnostics = attachPageDiagnostics(page, testInfo, 'webmeet-primary-auth-seed');
        await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
        seedTraceStarted = true;
        const ownerPrincipal = await signIn(page, smokeConfig.primaryUser, explorerUrl(), {
          requireConfiguredPrincipal: true,
        });
        const ownerStorageState = await page.context().storageState();

        const memberSeedContext = await browser.newContext({
          baseURL: smokeConfig.baseURL,
          ignoreHTTPSErrors: true,
          recordVideo: { dir: testInfo.outputPath('webmeet-secondary-auth-seed-video') },
        });
        let memberSeedPage = null;
        let memberSeedDiagnostics = null;
        let memberSeedTraceStarted = false;
        let memberSeedVideo = null;
        let memberStorageState;
        let memberPrincipal;
        try {
          await memberSeedContext.tracing.start({ screenshots: true, snapshots: true, sources: true });
          memberSeedTraceStarted = true;
          memberSeedPage = await memberSeedContext.newPage();
          memberSeedVideo = memberSeedPage.video();
          memberSeedDiagnostics = attachPageDiagnostics(memberSeedPage, testInfo, 'webmeet-secondary-auth-seed');
          memberPrincipal = await signIn(memberSeedPage, smokeConfig.secondaryUser, explorerUrl(), {
            requireConfiguredPrincipal: true,
          });
          memberStorageState = await memberSeedContext.storageState();
        } catch (error) {
          if (memberSeedPage && !memberSeedPage.isClosed()) {
            await failureCollector.required('secondary authentication failure screenshot', () => (
              memberSeedPage.screenshot({
                path: testInfo.outputPath('webmeet-secondary-auth-seed-failure.png'),
                fullPage: true,
              })
            ));
          }
          throw error;
        } finally {
          if (memberSeedTraceStarted) {
            await failureCollector.required('secondary authentication redacted trace', () => (
              stopAndAttachRedactedTrace(memberSeedContext, testInfo, 'webmeet-secondary-auth-seed')
            ));
          }
          await failureCollector.required('secondary authentication seed context close', () => memberSeedContext.close());
          if (memberSeedDiagnostics) {
            await failureCollector.required('secondary authentication diagnostics', () => memberSeedDiagnostics.flush());
            if (smokeConfig.flags.webmeetHeadless) {
              await failureCollector.required('secondary authentication zero browser errors', () => (
                expectNoUnfilteredBrowserErrors(memberSeedDiagnostics, 'secondary authentication')
              ));
            }
          }
          if (memberSeedVideo) {
            await failureCollector.required('secondary authentication seed video', async () => {
              const videoPath = await memberSeedVideo.path();
              await testInfo.attach('webmeet-secondary-auth-seed-video', {
                path: videoPath,
                contentType: 'video/webm',
              });
            });
          }
        }
        const [verifiedOwner, verifiedMember] = assertDistinctAuthenticatedPrincipals(ownerPrincipal, memberPrincipal);
        authenticatedPrincipals = { owner: verifiedOwner, member: verifiedMember };

        ownerContext = await browser.newContext({
          baseURL: smokeConfig.baseURL,
          ignoreHTTPSErrors: true,
          permissions: ['camera', 'microphone'],
          storageState: ownerStorageState,
          recordVideo: { dir: testInfo.outputPath('webmeet-primary-video') },
        });
        memberContext = await browser.newContext({
          baseURL: smokeConfig.baseURL,
          ignoreHTTPSErrors: true,
          permissions: ['camera', 'microphone'],
          storageState: memberStorageState,
          recordVideo: { dir: testInfo.outputPath('webmeet-secondary-video') },
        });
        const rtcProbeOptions = smokeConfig.flags.webmeetScreen
          ? { networkLane: 'direct-udp' }
          : {};
        await Promise.all([
          installRtcProbe(ownerContext, rtcProbeOptions),
          installRtcProbe(memberContext, rtcProbeOptions),
        ]);
        ownerPage = await ownerContext.newPage();
        memberPage = await memberContext.newPage();
        ownerDiagnostics = attachPageDiagnostics(
          ownerPage,
          testInfo,
          smokeConfig.flags.webmeetScreen ? 'webmeet-primary-screen' : 'webmeet-primary-headless',
        );
        memberDiagnostics = attachPageDiagnostics(memberPage, testInfo, 'webmeet-secondary');
        await ownerContext.tracing.start({ screenshots: true, snapshots: true, sources: true });
        ownerTraceStarted = true;
        await memberContext.tracing.start({ screenshots: true, snapshots: true, sources: true });
        memberTraceStarted = true;
      }

      await openWebMeet(ownerPage);
      roomCreationAttempted = true;
      await createRoom(ownerPage, roomTitle);
      await joinRoom(ownerPage, roomTitle);

      if (!memberContext) {
        memberContext = await browser.newContext({
          baseURL: smokeConfig.baseURL,
          ignoreHTTPSErrors: true,
          permissions: ['camera', 'microphone'],
        });
        await installRtcProbe(memberContext);
        memberPage = await memberContext.newPage();
        memberDiagnostics = attachPageDiagnostics(memberPage, testInfo, 'webmeet-secondary');
        const secondaryLoginOk = await trySignInToWebMeet(memberPage, smokeConfig.secondaryUser);
        if (smokeConfig.flags.webmeetRefresh) {
          expect(
            secondaryLoginOk,
            `SMOKE_WEBMEET_REFRESH requires secondary account ${smokeConfig.secondaryUser.username} to authenticate`,
          ).toBe(true);
        } else {
          test.skip(!secondaryLoginOk, `Secondary smoke account ${smokeConfig.secondaryUser.username} cannot log in.`);
        }
        await expectWebMeetReady(memberPage, { expectCreateRoom: false });
      } else {
        await openWebMeet(memberPage, smokeConfig.secondaryUser, { expectCreateRoom: false });
      }
      await joinRoom(memberPage, roomTitle);
      identities = await expectTwoDistinctWebMeetParticipants(ownerPage, memberPage);
      if (smokeConfig.flags.webmeetScreen || smokeConfig.flags.webmeetHeadless) {
        await attachJsonEvidence(testInfo, 'webmeet-authenticated-participant-identities', {
          authenticatedPrincipals,
          liveKitParticipants: identities,
        });
      }

      await sendWebMeetChat(ownerPage, ownerMessage);
      await expect(memberPage.locator('#webmeetChatList', { hasText: ownerMessage })).toBeVisible();
      await sendWebMeetChat(memberPage, memberMessage);
      await expect(ownerPage.locator('#webmeetChatList', { hasText: memberMessage })).toBeVisible();

      if (smokeConfig.flags.webmeetMedia) {
        await enableMedia(ownerPage);
        await enableMedia(memberPage);
        if (smokeConfig.flags.webmeetHeadless) {
          await Promise.all([
            expectBidirectionalAudioVideoRtp(ownerPage, {
              label: 'headless-owner',
              testInfo,
            }),
            expectBidirectionalAudioVideoRtp(memberPage, {
              label: 'headless-member',
              testInfo,
            }),
          ]);
          await Promise.all([
            expectWebMeetMediaState(ownerPage, {
              label: 'headless-owner',
              testInfo,
            }),
            expectWebMeetMediaState(memberPage, {
              label: 'headless-member',
              testInfo,
            }),
          ]);
        } else {
          await expectIncreasingRtpStats(ownerPage);
          await expectIncreasingRtpStats(memberPage);
        }
      }

      if (smokeConfig.flags.webmeetRefresh) {
        expect(smokeConfig.flags.webmeetMedia, 'SMOKE_WEBMEET_REFRESH requires SMOKE_WEBMEET_MEDIA=1').toBe(true);
        await expectJoinMaterialRefreshLifecycle({
          ownerPage,
          memberPage,
          label: 'local-two-account',
          testInfo,
        });
      }

      if (smokeConfig.flags.webmeetScreen) {
        await exerciseScreenShareDirection({
          sharerPage: ownerPage,
          receiverPage: memberPage,
          sharerIdentity: identities.ownerIdentity,
          receiverIdentity: identities.memberIdentity,
          label: 'account-a-to-account-b',
          testInfo,
          screenRuntimeEvidence,
        });
        await exerciseScreenShareDirection({
          sharerPage: memberPage,
          receiverPage: ownerPage,
          sharerIdentity: identities.memberIdentity,
          receiverIdentity: identities.ownerIdentity,
          label: 'account-b-to-account-a',
          testInfo,
          screenRuntimeEvidence,
        });
        const liveBox = screenRuntimeEvidence.deployment === 'box'
          ? screenRuntimeEvidence.box
          : null;
        const postRunScreenRuntimeEvidence = collectScreenRuntimeEvidence({
          deployment: screenRuntimeEvidence.deployment,
          baseURL: screenRuntimeEvidence.baseURL,
          expectedContainerName: liveBox?.box.containerName,
          expectedImageId: liveBox?.box.imageId,
          expectedImageRef: liveBox?.box.imageRef,
          publicIPv4: liveBox?.box.publicIPv4,
          generationMaxAgeMs: liveBox?.generationMaxAgeMs,
          imageMaxAgeMs: liveBox?.imageMaxAgeMs,
        });
        expect(
          sameScreenRuntimeGeneration(screenRuntimeEvidence, postRunScreenRuntimeEvidence),
          'the exact outer Box and LiveKit generations must remain unchanged through both screen directions',
        ).toBe(true);
        await attachJsonEvidence(
          testInfo,
          'post-screen-runtime-evidence',
          postRunScreenRuntimeEvidence,
        );
      }

      if (smokeConfig.flags.failOnBrowserErrors) {
        expect(memberDiagnostics.actionableEvents(), 'secondary browser console, page, or network errors').toEqual([]);
        if (ownerDiagnostics) {
          expect(ownerDiagnostics.actionableEvents(), 'primary WebMeet browser console, page, or network errors').toEqual([]);
        }
      }
    } catch (error) {
      primaryError = error;
      if (ownerPage && !ownerPage.isClosed()) {
        await failureCollector.required('primary WebMeet failure screenshot', () => (
          ownerPage.screenshot({ path: testInfo.outputPath('webmeet-primary-failure.png'), fullPage: true })
        ));
      } else if (ownerPage) {
        failureCollector.add('primary WebMeet failure screenshot', new Error('primary page was already closed'));
      }
      if (memberPage && !memberPage.isClosed()) {
        await failureCollector.required('secondary WebMeet failure screenshot', () => (
          memberPage.screenshot({ path: testInfo.outputPath('webmeet-secondary-failure.png'), fullPage: true })
        ));
      } else if (memberPage) {
        failureCollector.add('secondary WebMeet failure screenshot', new Error('secondary page was already closed'));
      }
    } finally {
      if (memberPage && !memberPage.isClosed()) {
        await failureCollector.required('secondary WebMeet final RTC evidence', () => (
          attachFinalWebMeetRtcEvidence(memberPage, testInfo, 'webmeet-secondary')
        ));
      } else if (memberPage) {
        failureCollector.add('secondary WebMeet final RTC evidence', new Error('secondary page was already closed'));
      }
      if (ownerPage && !ownerPage.isClosed()) {
        await failureCollector.required('primary WebMeet final RTC evidence', () => (
          attachFinalWebMeetRtcEvidence(ownerPage, testInfo, 'webmeet-primary')
        ));
      } else if (ownerPage) {
        failureCollector.add('primary WebMeet final RTC evidence', new Error('primary page was already closed'));
      }
      if (memberTraceStarted) {
        await failureCollector.required('secondary WebMeet redacted trace', () => (
          stopAndAttachRedactedTrace(memberContext, testInfo, 'webmeet-secondary')
        ));
      }
      if (memberContext) {
        await failureCollector.required('secondary WebMeet context close before room deletion', () => (
          memberContext.close()
        ));
        memberContext = null;
        memberPage = null;
      }
      if (roomCreationAttempted) {
        let roomDeleted = false;
        await failureCollector.required('WebMeet room deletion', async () => {
          let cleanupPage = ownerPage && !ownerPage.isClosed() ? ownerPage : null;
          if (!cleanupPage && page && !page.isClosed()) cleanupPage = page;
          if (!cleanupPage && ownerContext) cleanupPage = await ownerContext.newPage();
          if (!cleanupPage) throw new Error('no live primary-account browser page remains for room deletion');
          await openWebMeet(cleanupPage, smokeConfig.primaryUser);
          await deleteRoomIfPresent(cleanupPage, roomTitle);
          roomDeleted = true;
        });
        await failureCollector.required('WebMeet cleanup evidence', () => (
          attachJsonEvidence(testInfo, 'webmeet-cleanup', { roomTitle, attempted: true, deleted: roomDeleted })
        ));
      }
      if (seedTraceStarted) {
        await failureCollector.required('WebMeet authentication seed redacted trace', () => (
          stopAndAttachRedactedTrace(page.context(), testInfo, 'webmeet-auth-seed')
        ));
      }
      if (ownerTraceStarted) {
        await failureCollector.required('primary WebMeet redacted trace', () => (
          stopAndAttachRedactedTrace(ownerContext, testInfo, 'webmeet-primary')
        ));
      }
      if (ownerContext) await failureCollector.required('primary WebMeet context close', () => ownerContext.close());
      for (const [label, diagnostics] of [
        ['primary authentication', seedDiagnostics],
        ['primary WebMeet', ownerDiagnostics],
        ['secondary WebMeet', memberDiagnostics],
      ]) {
        if (!diagnostics) continue;
        await failureCollector.required(`${label} final diagnostics`, () => diagnostics.flush());
        if (smokeConfig.flags.webmeetHeadless) {
          await failureCollector.required(`${label} zero browser errors`, () => (
            expectNoUnfilteredBrowserErrors(diagnostics, label)
          ));
        }
      }
    }
    failureCollector.throwIfAny({ primaryError, label: 'two-account WebMeet gate' });
  });
});
