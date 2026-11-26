import { test, expect, attachPageDiagnostics } from '../lib/fixtures.mjs';
import { requireRealSignIns } from '../lib/session-reuse.mjs';
import { smokeConfig } from '../lib/config.mjs';
import {
  expectWebchatSuggestion,
  openTaggedWebchat,
  selectWebchatWorkspacePath,
  setComposer,
  uploadFolder,
  uploadOneFile,
  withWebchatUploadProject,
} from '../lib/webchat.mjs';

// The sibling WebChat context stands for a separate browser session of the same account.
requireRealSignIns(test);

test.describe('WebChat direct workspace uploads', () => {
  test('file uploads land in the selected working directory and are suggested in sibling sessions', async ({ page, browser }, testInfo) => {
    await withWebchatUploadProject(page, async (directory) => {
      await openTaggedWebchat(page, smokeConfig.primaryUser, directory);

      const upload = await uploadOneFile(page, testInfo, undefined, directory);
      await setComposer(page, `@${upload.name.slice(0, 8)}`);
      await expectWebchatSuggestion(page, {
        group: 'Files and folders',
        text: upload.name,
      });

      const secondContext = await browser.newContext({
        baseURL: smokeConfig.baseURL,
        ignoreHTTPSErrors: true,
        permissions: ['camera', 'microphone'],
      });
      const secondPage = await secondContext.newPage();
      const diagnostics = attachPageDiagnostics(secondPage, testInfo, 'sibling-webchat-session');
      try {
        await openTaggedWebchat(secondPage, smokeConfig.primaryUser, directory);
        await setComposer(secondPage, `@${upload.name.slice(0, 8)}`);
        await expectWebchatSuggestion(secondPage, {
          group: 'Files and folders',
          text: upload.name,
        });
        expect(diagnostics.actionableEvents(), 'sibling WebChat must remain error-free').toEqual([]);
      } finally {
        try {
          await diagnostics.flush();
        } finally {
          await secondContext.close();
        }
      }
    });
  });

  test('folder uploads preserve nested paths in the selected working directory', async ({ page }, testInfo) => {
    await withWebchatUploadProject(page, async (directory) => {
      await openTaggedWebchat(page, smokeConfig.primaryUser, directory);

      const upload = await uploadFolder(page, testInfo, undefined, directory);
      expect(upload.payload.relativePath).toBe(upload.relativePath);
      expect(upload.payload.workspacePath).toBe(`${directory}/${upload.relativePath}`);

      await selectWebchatWorkspacePath(page, upload.relativePath);
    });
  });
});
