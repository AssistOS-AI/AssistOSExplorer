import crypto from 'node:crypto';

import {
  attachPageDiagnostics,
  expect,
  test,
} from '../lib/fixtures.mjs';
import {
  assertDistinctAuthenticatedPrincipals,
  readAuthenticatedPrincipal,
  signIn,
} from '../lib/auth.mjs';
import {
  assignRoleThroughAdministration,
  deleteUserThroughAdministrationIfPresent,
  openAdminUsers,
} from '../lib/admin-users.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { dpuData } from '../lib/dpu-data.mjs';
import { dpuSnapshotPersistenceAdvanced } from '../lib/dpu-persistence.mjs';
import {
  assertExplorerDirectory,
  openExplorer,
} from '../lib/explorer.mjs';
import { createReleaseGateFailureCollector } from '../lib/release-gate-failures.mjs';
import { stopAndAttachRedactedTrace } from '../lib/redacted-trace.mjs';
import {
  createRoom,
  deleteRoomIfPresent,
  expectAuthenticatedStandaloneWebMeet,
  expectTwoDistinctWebMeetParticipants,
  joinStandaloneGuestRoom,
  joinRoom,
  openWebMeet,
  sendWebMeetChat,
} from '../lib/webmeet.mjs';

// Passwordless accounts: each signs up with an email code, then the
// administrator grants its role. Codes come from SMOKE_EMAIL_CODE_COMMAND.
const accountSuffix = `${smokeConfig.runId}-${crypto.randomBytes(4).toString('hex')}`.toLowerCase();
const ownerAccount = Object.freeze({
  username: `e2e-owner-${accountSuffix}`,
  loginEmail: `e2e-owner-${accountSuffix}@${smokeConfig.accountEmailDomain}`,
  signInMethod: 'emailCode',
});
const memberAccount = Object.freeze({
  username: `e2e-member-${accountSuffix}`,
  loginEmail: `e2e-member-${accountSuffix}@${smokeConfig.accountEmailDomain}`,
  signInMethod: 'emailCode',
});
const createdAccounts = [];
const ACCOUNT_PAGE = '/base-agent-additional-server/userPersistoAgent/7000/service/dashboard/';

function documentRow(page, documentPath) {
  return page.locator(`tr[data-entry-path="${documentPath}"]`);
}

function readDpuDocumentSnapshot(fileName) {
  if (!dpuData.exists('state.json')) return null;
  const state = dpuData.readJson('state.json');
  const object = Object.values(state?.confidentialObjects || {}).find((entry) => (
    entry?.type === 'file' && entry?.name === fileName
  ));
  if (!object?.id || !dpuData.exists('blobs', object.id)) return null;
  const blob = dpuData.readBuffer('blobs', object.id);
  return {
    id: object.id,
    mimeType: String(object.mimeType || ''),
    updatedAt: String(object.updatedAt || ''),
    blobBytes: blob.length,
    blobSha256: crypto.createHash('sha256').update(blob).digest('hex'),
  };
}

async function collectOnlyOfficeFrameText(page) {
  const entries = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const url = frame.url();
    let text = '';
    try {
      text = await frame.locator('body').innerText({ timeout: 1_000 });
    } catch {
      // A not-yet-ready nested editor frame contributes only its URL.
    }
    if (
      /onlyoffice|web-apps|documenteditor|doceditor|sdkjs/i.test(url)
      || /ONLYOFFICE|Download failed|Word count|Page \d+ of/i.test(text)
    ) {
      entries.push({ url, text });
    }
  }
  return entries;
}

async function waitForOnlyOfficeEditor(page) {
  await expect(page.locator('onlyoffice-editor-host iframe, .onlyoffice-editor-host iframe').first())
    .toBeVisible({ timeout: smokeConfig.timeouts.navigation });

  await expect.poll(async () => {
    const entries = await collectOnlyOfficeFrameText(page);
    const combined = entries.map((entry) => entry.text).join('\n');
    if (/Download failed/i.test(combined)) return 'download-failed';
    return entries.some((entry) => (
      /documenteditor|web-apps/i.test(entry.url)
      || /ONLYOFFICE|Word count|Page \d+ of/i.test(entry.text)
    )) ? 'loaded' : 'waiting';
  }, {
    message: 'OnlyOffice must load the .docx without a download failure.',
    timeout: smokeConfig.timeouts.navigation,
  }).toBe('loaded');

  let editorFrame = null;
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      if (await frame.locator('#area_id').count()) {
        editorFrame = frame;
        return frame.url();
      }
    }
    return '';
  }, {
    message: 'OnlyOffice must expose its real writable document input.',
    timeout: smokeConfig.timeouts.navigation,
  }).toMatch(/documenteditor|web-apps|onlyoffice/i);
  return editorFrame;
}

async function readOnlyOfficeDocumentText(editorFrame) {
  return editorFrame.evaluate(() => {
    const application = window.DE?.getApplication?.();
    const candidates = [
      application?.getController?.('Main')?.api,
      window.Asc?.editor,
      window.editor,
    ];
    const api = candidates.find((candidate) => (
      typeof candidate?.asc_EditSelectAll === 'function'
      && typeof candidate?.asc_GetSelectedText === 'function'
    ));
    if (!api) {
      throw new Error('OnlyOffice did not expose its document text API.');
    }
    api.asc_EditSelectAll();
    return String(api.asc_GetSelectedText() || '');
  });
}

async function typeOnlyOfficeMarker(page, editorFrame, marker) {
  const editorCanvas = editorFrame.locator('#id_viewer_overlay');
  await expect(editorCanvas).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
  const canvasBox = await editorCanvas.boundingBox();
  expect(canvasBox, 'OnlyOffice editor canvas must have a rendered browser box.').not.toBeNull();
  await page.mouse.click(
    canvasBox.x + (canvasBox.width / 2),
    canvasBox.y + Math.min(canvasBox.height / 3, 180)
  );

  const input = editorFrame.locator('#area_id');
  await expect(input).toBeAttached();
  await input.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(marker);
  await expect.poll(() => readOnlyOfficeDocumentText(editorFrame), {
    message: 'OnlyOffice document model must contain the typed marker.',
    timeout: smokeConfig.timeouts.action,
  }).toContain(marker);
}

async function waitForOnlyOfficeAutosave(editorFrame) {
  const savedStatus = editorFrame.getByText('All changes saved', { exact: true }).last();
  await expect(savedStatus, 'OnlyOffice must report automatic persistence without a Save click.').toBeVisible({
    timeout: Math.max(smokeConfig.timeouts.navigation, 90_000),
  });
}

async function createConfidentialDoc(page, fileName, documentPath) {
  await openExplorer(page, {
    account: ownerAccount,
    hash: 'file-exp/Confidential/My%20Space',
  });
  await assertExplorerDirectory(page, '/Confidential/My Space');
  await expect(page.locator('#toolbarMenuButton')).toBeEnabled();

  let promptMessage = '';
  page.once('dialog', async (dialog) => {
    promptMessage = dialog.message();
    await dialog.accept(fileName);
  });
  await page.locator('#toolbarMenuButton').click();
  await page.getByRole('menuitem', { name: 'New File' }).click();
  expect(promptMessage).toMatch(/Enter name for the new file/i);
  await expect(documentRow(page, documentPath)).toHaveCount(1, {
    timeout: smokeConfig.timeouts.navigation,
  });
}

async function openConfidentialDoc(page, documentPath) {
  const sessionResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith('/control/office/session')
      && url.searchParams.get('path') === documentPath
    );
  }, { timeout: smokeConfig.timeouts.navigation });
  await documentRow(page, documentPath).locator('td.col-name').click();
  const sessionResponse = await sessionResponsePromise;
  expect(sessionResponse.status()).toBe(200);
  const session = await sessionResponse.json();
  expect(session.ok).toBe(true);
  expect(session.preview).toMatchObject({
    requestedPath: documentPath,
    storageKind: 'dpu',
  });
  expect(session.config).toMatchObject({
    documentType: 'word',
    document: {
      fileType: 'docx',
      permissions: {
        edit: true,
      },
    },
    editorConfig: {
      mode: 'edit',
      customization: {
        autosave: true,
      },
    },
  });
  return {
    editorFrame: await waitForOnlyOfficeEditor(page),
    editorConfiguration: {
      documentType: session.config.documentType,
      fileType: session.config.document.fileType,
      mode: session.config.editorConfig.mode,
      edit: session.config.document.permissions.edit,
      autosave: session.config.editorConfig.customization.autosave,
    },
  };
}

async function deleteConfidentialDoc(page, documentPath) {
  await openExplorer(page, {
    account: ownerAccount,
    hash: 'file-exp/Confidential/My%20Space',
  });
  await assertExplorerDirectory(page, '/Confidential/My Space');
  const row = documentRow(page, documentPath);
  if (await row.count() === 0) return;
  await row.locator('.action-menu-trigger').click();
  const deleteButton = row.getByRole('menuitem', { name: 'Delete' });
  await expect(deleteButton).toBeVisible({ timeout: smokeConfig.timeouts.action });
  page.once('dialog', async (dialog) => dialog.accept());
  await deleteButton.click();
  await expect(row).toHaveCount(0, { timeout: smokeConfig.timeouts.navigation });
}

test.describe('Explorer QA acceptance', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!smokeConfig.flags.qaAcceptance, 'Run with npm run test:qa.');

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(Math.max(smokeConfig.timeouts.test, 180_000));
    const context = await browser.newContext({
      baseURL: smokeConfig.baseURL,
      ignoreHTTPSErrors: true,
    });
    try {
      // Each account is created by its own completed email-code sign-up.
      for (const account of [ownerAccount, memberAccount]) {
        const signUpContext = await browser.newContext({ baseURL: smokeConfig.baseURL, ignoreHTTPSErrors: true });
        try {
          await signIn(await signUpContext.newPage(), account, ACCOUNT_PAGE);
          createdAccounts.push(account);
        } finally {
          await signUpContext.close();
        }
      }
      const dialog = await openAdminUsers(await context.newPage());
      await assignRoleThroughAdministration(dialog, ownerAccount, {
        name: `E2E Owner ${smokeConfig.runId}`,
        role: 'admin',
      });
      await assignRoleThroughAdministration(dialog, memberAccount, {
        name: `E2E Member ${smokeConfig.runId}`,
        role: 'user',
      });
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser }, testInfo) => {
    if (!createdAccounts.length) return;
    testInfo.setTimeout(Math.max(smokeConfig.timeouts.test, 180_000));
    const context = await browser.newContext({
      baseURL: smokeConfig.baseURL,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    try {
      const dialog = await openAdminUsers(page);
      for (const account of [...createdAccounts].reverse()) {
        await deleteUserThroughAdministrationIfPresent(dialog, account);
      }
    } finally {
      await context.close();
    }
  });

  test('Confidential .docx edits in OnlyOffice and saves automatically', async ({ browser }, testInfo) => {
    test.setTimeout(Math.max(smokeConfig.timeouts.test, 180_000));
    const fileName = `e2e-confidential-${smokeConfig.runId}.docx`;
    const documentPath = `/Confidential/My Space/${fileName}`;
    const marker = `Confidential-docx-e2e-${smokeConfig.runId}`;
    const context = await browser.newContext({
      baseURL: smokeConfig.baseURL,
      ignoreHTTPSErrors: true,
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    let traceStarted = true;
    const page = await context.newPage();
    let diagnostics = null;
    let editorConfiguration = null;
    let callbackSnapshot = null;
    let reopenedText = '';
    let primaryError = null;
    const failureCollector = createReleaseGateFailureCollector();
    try {
      await deleteConfidentialDoc(page, documentPath);
      await createConfidentialDoc(page, fileName, documentPath);
      const initialSnapshot = readDpuDocumentSnapshot(fileName);
      expect(
        initialSnapshot,
        'The newly created Confidential document must have an encrypted DPU blob.',
      ).not.toBeNull();
      expect(initialSnapshot.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      const opened = await openConfidentialDoc(page, documentPath);
      editorConfiguration = opened.editorConfiguration;
      diagnostics = attachPageDiagnostics(page, testInfo, 'qa-onlyoffice');
      await typeOnlyOfficeMarker(page, opened.editorFrame, marker);
      await waitForOnlyOfficeAutosave(opened.editorFrame);

      diagnostics.pause();
      let reopened;
      try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openExplorer(page, {
          account: ownerAccount,
          hash: 'file-exp/Confidential/My%20Space',
        });
        await assertExplorerDirectory(page, '/Confidential/My Space');
        await expect.poll(() => {
          callbackSnapshot = readDpuDocumentSnapshot(fileName);
          return callbackSnapshot?.id === initialSnapshot.id
            && dpuSnapshotPersistenceAdvanced(initialSnapshot, callbackSnapshot);
        }, {
          message: 'OnlyOffice unload must durably replace the encrypted DPU blob before reopening.',
          timeout: smokeConfig.timeouts.navigation,
        }).toBe(true);
        reopened = await openConfidentialDoc(page, documentPath);
      } finally {
        diagnostics.resume();
      }
      await expect.poll(async () => {
        reopenedText = await readOnlyOfficeDocumentText(reopened.editorFrame);
        return reopenedText;
      }, {
        message: 'The automatically saved OnlyOffice marker must persist after reopening.',
        timeout: smokeConfig.timeouts.navigation,
      }).toContain(marker);

      if (smokeConfig.flags.failOnBrowserErrors) {
        expect(diagnostics.actionableEvents(), 'OnlyOffice browser errors').toEqual([]);
      }
      await testInfo.attach('qa-onlyoffice-evidence.json', {
        body: Buffer.from(JSON.stringify({
          documentPath,
          mimeType: initialSnapshot.mimeType,
          editorConfiguration,
          marker,
          durableCallback: {
            objectIdentityPreserved: callbackSnapshot?.id === initialSnapshot.id,
            initialBlobSha256: initialSnapshot.blobSha256,
            callbackBlobSha256: callbackSnapshot?.blobSha256 || '',
            initialUpdatedAt: initialSnapshot.updatedAt,
            callbackUpdatedAt: callbackSnapshot?.updatedAt || '',
            callbackBlobBytes: callbackSnapshot?.blobBytes || 0,
          },
          markerPersistedAfterReopen: reopenedText.includes(marker),
          saveButtonClicked: false,
        }, null, 2)),
        contentType: 'application/json',
      });
      const screenshotPath = testInfo.outputPath('qa-onlyoffice-success.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await testInfo.attach('qa-onlyoffice-success-screenshot', {
        path: screenshotPath,
        contentType: 'image/png',
      });
    } catch (error) {
      primaryError = error;
      await failureCollector.required('OnlyOffice failure screenshot', () => (
        page.screenshot({
          path: testInfo.outputPath('qa-onlyoffice-failure.png'),
          fullPage: true,
        })
      ));
    } finally {
      await failureCollector.required('run-scoped Confidential document deletion', () => (
        deleteConfidentialDoc(page, documentPath)
      ));
      if (diagnostics) {
        await failureCollector.required('OnlyOffice diagnostics', () => diagnostics.flush());
      }
      if (traceStarted) {
        traceStarted = false;
        await failureCollector.required('OnlyOffice redacted trace', () => (
          stopAndAttachRedactedTrace(context, testInfo, 'qa-onlyoffice')
        ));
      }
      await failureCollector.required('OnlyOffice browser context close', () => context.close());
    }
    failureCollector.throwIfAny({ primaryError, label: 'Explorer QA OnlyOffice acceptance' });
  });

  test('two generated users join one WebMeet room and both see chat', async ({ browser }, testInfo) => {
    test.setTimeout(Math.max(smokeConfig.timeouts.test, 240_000));
    const roomTitle = `e2e-room-${smokeConfig.runId}`;
    const guestRoomTitle = `e2e-public-room-${smokeConfig.runId}`;
    const guestDisplayName = `e2e-guest-${smokeConfig.runId}`;
    const ownerMessage = `chat-from-owner-${smokeConfig.runId}`;
    const memberMessage = `chat-from-member-${smokeConfig.runId}`;
    const ownerContext = await browser.newContext({
      baseURL: smokeConfig.baseURL,
      ignoreHTTPSErrors: true,
    });
    const memberContext = await browser.newContext({
      baseURL: smokeConfig.baseURL,
      ignoreHTTPSErrors: true,
    });
    const guestContext = await browser.newContext({
      baseURL: smokeConfig.baseURL,
      ignoreHTTPSErrors: true,
    });
    const ownerPage = await ownerContext.newPage();
    const ownerStandalonePage = await ownerContext.newPage();
    const memberPage = await memberContext.newPage();
    const guestPage = await guestContext.newPage();
    const ownerDiagnostics = attachPageDiagnostics(ownerPage, testInfo, 'qa-webmeet-owner');
    const ownerStandaloneDiagnostics = attachPageDiagnostics(
      ownerStandalonePage,
      testInfo,
      'qa-webmeet-owner-standalone',
    );
    const memberDiagnostics = attachPageDiagnostics(memberPage, testInfo, 'qa-webmeet-member');
    const guestDiagnostics = attachPageDiagnostics(guestPage, testInfo, 'qa-webmeet-guest');
    let roomCreated = false;
    let guestRoomCreated = false;
    let guestRoomId = '';
    let primaryError = null;
    const failureCollector = createReleaseGateFailureCollector();
    try {
      await openWebMeet(ownerPage, ownerAccount);
      await deleteRoomIfPresent(ownerPage, roomTitle);
      await deleteRoomIfPresent(ownerPage, guestRoomTitle);
      await expectAuthenticatedStandaloneWebMeet(ownerStandalonePage);
      guestRoomId = await createRoom(ownerPage, guestRoomTitle, { roomType: 'guest' });
      guestRoomCreated = true;
      await joinStandaloneGuestRoom(guestPage, {
        roomId: guestRoomId,
        displayName: guestDisplayName,
      });
      await createRoom(ownerPage, roomTitle);
      roomCreated = true;
      await openWebMeet(memberPage, memberAccount, { expectCreateRoom: false });
      const [ownerPrincipal, memberPrincipal] = assertDistinctAuthenticatedPrincipals(
        await readAuthenticatedPrincipal(ownerPage, ownerAccount),
        await readAuthenticatedPrincipal(memberPage, memberAccount)
      );

      await joinRoom(ownerPage, roomTitle);
      await joinRoom(memberPage, roomTitle);
      const participants = await expectTwoDistinctWebMeetParticipants(ownerPage, memberPage);

      await sendWebMeetChat(ownerPage, ownerMessage);
      await expect(memberPage.locator('#webmeetChatList', { hasText: ownerMessage })).toBeVisible();
      await sendWebMeetChat(memberPage, memberMessage);
      await expect(ownerPage.locator('#webmeetChatList', { hasText: memberMessage })).toBeVisible();

      if (smokeConfig.flags.failOnBrowserErrors) {
        expect(ownerDiagnostics.actionableEvents(), 'owner WebMeet browser errors').toEqual([]);
        expect(
          ownerStandaloneDiagnostics.actionableEvents(),
          'owner standalone WebMeet browser errors',
        ).toEqual([]);
        expect(memberDiagnostics.actionableEvents(), 'member WebMeet browser errors').toEqual([]);
        expect(guestDiagnostics.actionableEvents(), 'guest WebMeet browser errors').toEqual([]);
      }
      await testInfo.attach('qa-webmeet-evidence.json', {
        body: Buffer.from(JSON.stringify({
          roomTitle,
          standaloneLoader: {
            authenticated: true,
            guestRoomId,
            guestDisplayName,
            guestJoined: true,
          },
          explorerPrincipals: {
            owner: { id: ownerPrincipal.canonicalId, username: ownerPrincipal.canonicalUsername },
            member: { id: memberPrincipal.canonicalId, username: memberPrincipal.canonicalUsername },
          },
          liveKitParticipants: participants,
          chatVisibility: {
            ownerMessageVisibleToMember: true,
            memberMessageVisibleToOwner: true,
          },
        }, null, 2)),
        contentType: 'application/json',
      });
    } catch (error) {
      primaryError = error;
      await Promise.all([
        failureCollector.required('owner WebMeet failure screenshot', () => ownerPage.screenshot({
          path: testInfo.outputPath('qa-webmeet-owner-failure.png'),
          fullPage: true,
        })),
        failureCollector.required('owner standalone WebMeet failure screenshot', () => (
          ownerStandalonePage.screenshot({
            path: testInfo.outputPath('qa-webmeet-owner-standalone-failure.png'),
            fullPage: true,
          })
        )),
        failureCollector.required('member WebMeet failure screenshot', () => memberPage.screenshot({
          path: testInfo.outputPath('qa-webmeet-member-failure.png'),
          fullPage: true,
        })),
        failureCollector.required('guest WebMeet failure screenshot', () => guestPage.screenshot({
          path: testInfo.outputPath('qa-webmeet-guest-failure.png'),
          fullPage: true,
        })),
      ]);
    } finally {
      if ((roomCreated || guestRoomCreated) && !ownerPage.isClosed()) {
        await failureCollector.required('run-scoped WebMeet room deletion', async () => {
          await openWebMeet(ownerPage, ownerAccount);
          if (roomCreated) await deleteRoomIfPresent(ownerPage, roomTitle);
          if (guestRoomCreated) await deleteRoomIfPresent(ownerPage, guestRoomTitle);
        });
      }
      await Promise.all([
        failureCollector.required('owner WebMeet diagnostics', () => ownerDiagnostics.flush()),
        failureCollector.required(
          'owner standalone WebMeet diagnostics',
          () => ownerStandaloneDiagnostics.flush(),
        ),
        failureCollector.required('member WebMeet diagnostics', () => memberDiagnostics.flush()),
        failureCollector.required('guest WebMeet diagnostics', () => guestDiagnostics.flush()),
        failureCollector.required('owner WebMeet browser context close', () => ownerContext.close()),
        failureCollector.required('member WebMeet browser context close', () => memberContext.close()),
        failureCollector.required('guest WebMeet browser context close', () => guestContext.close()),
      ]);
    }
    failureCollector.throwIfAny({ primaryError, label: 'Explorer QA WebMeet acceptance' });
  });
});
