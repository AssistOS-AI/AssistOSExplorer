import { chromium } from '@playwright/test';

import {
  assertDistinctAuthenticatedPrincipals,
  normalizePrincipalComponent,
} from '../lib/auth.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { attachPageDiagnostics, expect, installRtcProbe, test } from '../lib/fixtures.mjs';
import { parseTurnEndpoint, requirePublicIpv4 } from '../lib/network.mjs';
import { stopAndAttachRedactedTrace } from '../lib/redacted-trace.mjs';
import { createReleaseGateFailureCollector } from '../lib/release-gate-failures.mjs';
import {
  validateExternalTcpNegativeEvidence,
  validateBoxEvidence,
} from '../lib/box-evidence.mjs';
import {
  attachJsonEvidence,
  attachFinalWebMeetRtcEvidence,
  createRoom,
  deleteRoomIfPresent,
  enableMedia,
  expectBidirectionalAudioVideoRtp,
  expectJoinMaterialRefreshLifecycle,
  expectTwoDistinctWebMeetParticipants,
  expectWebMeetNetworkLane,
  joinRoom,
  openWebMeet,
  sendWebMeetChat,
} from '../lib/webmeet.mjs';

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required for the external WebMeet network matrix.`);
  return value;
}

async function browserEgress(page, echoUrl) {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`egress echo returned ${response.status}`);
    const text = await response.text();
    try {
      const payload = JSON.parse(text);
      return String(payload.ip || payload.address || '').trim();
    } catch (_) {
      return text.trim();
    }
  }, echoUrl);
}

test.describe('WebMeet native external-network matrix @external', () => {
  test('two remote browsers use the required direct or TURN lane', async ({}, testInfo) => {
    test.skip(!smokeConfig.flags.webmeetNetworkMatrix, 'SMOKE_WEBMEET_NETWORK_MATRIX is off.');
    test.setTimeout(smokeConfig.flags.webmeetRefresh
      ? Math.max(smokeConfig.timeouts.test, (smokeConfig.timeouts.webmeetRefresh * 2) + 180_000)
      : smokeConfig.timeouts.test);
    const lane = required('SMOKE_WEBMEET_NETWORK_LANE');
    expect(['direct-udp', 'turn-udp', 'turn-tls']).toContain(lane);
    const publicIPv4 = requirePublicIpv4(required('SMOKE_WEBMEET_PUBLIC_IPV4'), 'SMOKE_WEBMEET_PUBLIC_IPV4');
    const networkA = required('SMOKE_BROWSER_A_NETWORK_ID');
    const networkB = required('SMOKE_BROWSER_B_NETWORK_ID');
    const expectedEgressA = requirePublicIpv4(required('SMOKE_BROWSER_A_EXPECTED_EGRESS_IPV4'), 'SMOKE_BROWSER_A_EXPECTED_EGRESS_IPV4');
    const expectedEgressB = requirePublicIpv4(required('SMOKE_BROWSER_B_EXPECTED_EGRESS_IPV4'), 'SMOKE_BROWSER_B_EXPECTED_EGRESS_IPV4');
    const scannerSourceSha256 = required('SMOKE_EXTERNAL_SCANNER_SOURCE_SHA256');
    const scannerTargetASha256 = required('SMOKE_EXTERNAL_SCANNER_A_TARGET_SHA256');
    const scannerTargetBSha256 = required('SMOKE_EXTERNAL_SCANNER_B_TARGET_SHA256');
    const scannerHostKeyASha256 = required('SMOKE_EXTERNAL_SCANNER_A_HOST_FINGERPRINT_SHA256');
    const scannerHostKeyBSha256 = required('SMOKE_EXTERNAL_SCANNER_B_HOST_FINGERPRINT_SHA256');
    const echoUrl = required('SMOKE_NETWORK_ECHO_URL');
    const turnEndpoint = lane === 'turn-udp'
      ? parseTurnEndpoint(required('SMOKE_EXTERNAL_TURN_UDP_URL'), {
          name: 'SMOKE_EXTERNAL_TURN_UDP_URL',
          expectedScheme: 'turn',
          expectedTransport: 'udp',
        })
      : lane === 'turn-tls'
        ? parseTurnEndpoint(required('SMOKE_EXTERNAL_TURN_TLS_URL'), {
            name: 'SMOKE_EXTERNAL_TURN_TLS_URL',
            expectedScheme: 'turns',
            expectedTransport: 'tcp',
          })
        : null;
    expect(networkA).not.toBe(networkB);
    expect(expectedEgressA).not.toBe(expectedEgressB);
    required('SMOKE_USERNAME');
    required('SMOKE_SECONDARY_USERNAME');
    // UserPersisto accounts are passwordless; only the designated administrator
    // may use the deployment-configured administrator password.
    for (const account of [smokeConfig.primaryUser, smokeConfig.secondaryUser]) {
      if (account.signInMethod === 'adminPassword') required('SMOKE_ADMIN_PASSWORD');
      else if (account.signInMethod === 'totp') expect(account.totpSecret, 'an enrolled authenticator secret is required').toBeTruthy();
      else required('SMOKE_EMAIL_CODE_COMMAND');
    }
    expect(
      normalizePrincipalComponent(smokeConfig.primaryUser.username, 'primary configured account username'),
    ).not.toBe(normalizePrincipalComponent(smokeConfig.secondaryUser.username, 'secondary configured account username'));
    expect(
      smokeConfig.flags.failOnBrowserErrors,
      'SMOKE_ALLOW_BROWSER_ERRORS is forbidden for the external WebMeet release matrix',
    ).toBe(true);
    const containerEngineEvidence = JSON.parse(required('SMOKE_CONTAINER_ENGINE_EVIDENCE'));
    expect(containerEngineEvidence).toMatchObject({
      networkBackend: 'netavark',
      rootless: true,
      podmanServerOsArch: `linux/${process.arch === 'x64' ? 'amd64' : process.arch}`,
    });
    expect(containerEngineEvidence.podmanClientVersion).toBeTruthy();
    expect(containerEngineEvidence.podmanServerVersion).toBeTruthy();
    expect(containerEngineEvidence.netavarkVersion).toContain('netavark');
    expect(containerEngineEvidence.aardvarkDnsVersion).toContain('aardvark-dns');
    const boxEvidence = validateBoxEvidence(containerEngineEvidence.box, {
      expectedContainerName: required('SMOKE_PLOINKY_BOX_CONTAINER'),
      expectedImageId: required('SMOKE_EXPECT_BOX_IMAGE_ID'),
      expectedImageRef: required('SMOKE_EXPECT_BOX_IMAGE_REF'),
      baseURL: smokeConfig.baseURL,
      publicIPv4,
    });
    const externalTcpNegative = validateExternalTcpNegativeEvidence(
      containerEngineEvidence.externalTcpNegative,
      {
        runId: required('SMOKE_EXTERNAL_TCP_PROBE_RUN_ID'),
        boxEvidence,
        networkSources: [
          {
            networkId: networkA,
            egressIPv4: expectedEgressA,
            scannerSourceSha256,
            scannerTargetSha256: scannerTargetASha256,
            scannerHostKeySha256: scannerHostKeyASha256,
          },
          {
            networkId: networkB,
            egressIPv4: expectedEgressB,
            scannerSourceSha256,
            scannerTargetSha256: scannerTargetBSha256,
            scannerHostKeySha256: scannerHostKeyBSha256,
          },
        ],
      },
    );
    await attachJsonEvidence(testInfo, 'container-engine-evidence.json', {
      ...containerEngineEvidence,
      box: boxEvidence,
      externalTcpNegative,
    });

    let browserA = null;
    let browserB = null;
    let contextA = null;
    let contextB = null;
    let traceAStarted = false;
    let traceBStarted = false;
    let pageA = null;
    let pageB = null;
    let diagnosticsA = null;
    let diagnosticsB = null;
    let roomCreationAttempted = false;
    let primaryError = null;
    const failureCollector = createReleaseGateFailureCollector();
    const roomTitle = `network-${lane}-${smokeConfig.runId}`;

    try {
      browserA = await chromium.connectOverCDP(required('SMOKE_BROWSER_A_CDP_URL'));
      browserB = await chromium.connectOverCDP(required('SMOKE_BROWSER_B_CDP_URL'));
      contextA = await browserA.newContext({ baseURL: smokeConfig.baseURL, ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
      contextB = await browserB.newContext({ baseURL: smokeConfig.baseURL, ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
      await Promise.all([
        installRtcProbe(contextA, { networkLane: lane, expectedTurnEndpoint: turnEndpoint }),
        installRtcProbe(contextB, { networkLane: lane, expectedTurnEndpoint: turnEndpoint }),
      ]);
      await contextA.tracing.start({ screenshots: true, snapshots: true, sources: true });
      traceAStarted = true;
      await contextB.tracing.start({ screenshots: true, snapshots: true, sources: true });
      traceBStarted = true;
      pageA = await contextA.newPage();
      pageB = await contextB.newPage();
      diagnosticsA = attachPageDiagnostics(pageA, testInfo, 'external-browser-a');
      diagnosticsB = attachPageDiagnostics(pageB, testInfo, 'external-browser-b');
      expect(await browserEgress(pageA, echoUrl), 'browser A external IPv4').toBe(expectedEgressA);
      expect(await browserEgress(pageB, echoUrl), 'browser B external IPv4').toBe(expectedEgressB);
      const [principalA, principalB] = await Promise.all([
        openWebMeet(pageA, smokeConfig.primaryUser, { requireConfiguredPrincipal: true }),
        openWebMeet(pageB, smokeConfig.secondaryUser, { expectCreateRoom: false, requireConfiguredPrincipal: true }),
      ]);
      const [verifiedPrincipalA, verifiedPrincipalB] = assertDistinctAuthenticatedPrincipals(principalA, principalB);

      roomCreationAttempted = true;
      await createRoom(pageA, roomTitle);
      await joinRoom(pageA, roomTitle);
      await joinRoom(pageB, roomTitle);
      const liveKitParticipants = await expectTwoDistinctWebMeetParticipants(pageA, pageB);
      await attachJsonEvidence(testInfo, 'external-authenticated-participant-identities', {
        authenticatedPrincipals: {
          browserA: verifiedPrincipalA,
          browserB: verifiedPrincipalB,
        },
        liveKitParticipants,
      });
      await sendWebMeetChat(pageA, `network-a-${smokeConfig.runId}`);
      await sendWebMeetChat(pageB, `network-b-${smokeConfig.runId}`);
      await enableMedia(pageA);
      await enableMedia(pageB);
      await expectBidirectionalAudioVideoRtp(pageA, { label: 'external-browser-a', testInfo });
      await expectBidirectionalAudioVideoRtp(pageB, { label: 'external-browser-b', testInfo });
      await expectWebMeetNetworkLane(pageA, {
        lane,
        publicIPv4,
        turnEndpoint,
        label: 'external-browser-a',
        testInfo,
      });
      await expectWebMeetNetworkLane(pageB, {
        lane,
        publicIPv4,
        turnEndpoint,
        label: 'external-browser-b',
        testInfo,
      });
      if (smokeConfig.flags.webmeetRefresh) {
        expect(lane, 'credential lifecycle gate must run through the restrictive TURN/TLS lane').toBe('turn-tls');
        await expectJoinMaterialRefreshLifecycle({
          ownerPage: pageA,
          memberPage: pageB,
          label: 'external-turn-tls',
          testInfo,
        });
        await expectWebMeetNetworkLane(pageA, {
          lane,
          publicIPv4,
          turnEndpoint,
          label: 'external-browser-a-post-refresh',
          testInfo,
        });
        await expectWebMeetNetworkLane(pageB, {
          lane,
          publicIPv4,
          turnEndpoint,
          label: 'external-browser-b-post-refresh',
          testInfo,
        });
      }
      expect(diagnosticsA.actionableEvents(), 'external browser A console, page, or network errors').toEqual([]);
      expect(diagnosticsB.actionableEvents(), 'external browser B console, page, or network errors').toEqual([]);
    } catch (error) {
      primaryError = error;
      if (pageA && !pageA.isClosed()) {
        await failureCollector.required('external browser A failure screenshot', () => (
          pageA.screenshot({ path: testInfo.outputPath('external-browser-a-failure.png'), fullPage: true })
        ));
      } else if (pageA) {
        failureCollector.add('external browser A failure screenshot', new Error('browser A page was already closed'));
      }
      if (pageB && !pageB.isClosed()) {
        await failureCollector.required('external browser B failure screenshot', () => (
          pageB.screenshot({ path: testInfo.outputPath('external-browser-b-failure.png'), fullPage: true })
        ));
      } else if (pageB) {
        failureCollector.add('external browser B failure screenshot', new Error('browser B page was already closed'));
      }
    } finally {
      if (pageA && !pageA.isClosed()) {
        await failureCollector.required('external browser A final RTC evidence', () => (
          attachFinalWebMeetRtcEvidence(pageA, testInfo, 'external-browser-a')
        ));
      } else if (pageA) {
        failureCollector.add('external browser A final RTC evidence', new Error('browser A page was already closed'));
      }
      if (pageB && !pageB.isClosed()) {
        await failureCollector.required('external browser B final RTC evidence', () => (
          attachFinalWebMeetRtcEvidence(pageB, testInfo, 'external-browser-b')
        ));
      } else if (pageB) {
        failureCollector.add('external browser B final RTC evidence', new Error('browser B page was already closed'));
      }
      if (diagnosticsA) await failureCollector.required('external browser A diagnostics', () => diagnosticsA.flush());
      if (diagnosticsB) await failureCollector.required('external browser B diagnostics', () => diagnosticsB.flush());
      if (traceAStarted) {
        await failureCollector.required('external browser A redacted trace', () => (
          stopAndAttachRedactedTrace(contextA, testInfo, 'external-browser-a')
        ));
      }
      if (traceBStarted) {
        await failureCollector.required('external browser B redacted trace', () => (
          stopAndAttachRedactedTrace(contextB, testInfo, 'external-browser-b')
        ));
      }
      if (roomCreationAttempted) {
        await failureCollector.required('external WebMeet room deletion', async () => {
          let cleanupPage = pageA && !pageA.isClosed() ? pageA : null;
          if (!cleanupPage) {
            if (!contextA) throw new Error('browser A context is unavailable for room deletion');
            cleanupPage = await contextA.newPage();
          }
          await openWebMeet(cleanupPage, smokeConfig.primaryUser);
          await deleteRoomIfPresent(cleanupPage, roomTitle);
        });
      }
      if (contextA) await failureCollector.required('external browser A context close', () => contextA.close());
      if (contextB) await failureCollector.required('external browser B context close', () => contextB.close());
      if (browserA) await failureCollector.required('external browser A disconnect', () => browserA.close());
      if (browserB) await failureCollector.required('external browser B disconnect', () => browserB.close());
    }
    failureCollector.throwIfAny({ primaryError, label: `WebMeet ${lane} external-network gate` });
  });
});
