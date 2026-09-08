import { expect } from './fixtures.mjs';
import { smokeConfig } from './config.mjs';

export function directoryRow(page, directoryPath) {
  return page.locator(`tr[data-entry-path="${directoryPath}"]`);
}

export async function createDirectory(page, directoryName, directoryPath) {
  let promptMessage = '';
  page.once('dialog', async (dialog) => {
    promptMessage = dialog.message();
    await dialog.accept(directoryName);
  });
  await page.locator('#toolbarMenuButton').click();
  await page.getByRole('menuitem', { name: 'New Folder', exact: true }).click();
  expect(promptMessage).toMatch(/Enter name for the new directory/i);
  await expect(directoryRow(page, directoryPath)).toHaveCount(1, {
    timeout: smokeConfig.timeouts.navigation,
  });
}

export async function deleteDirectoryIfPresent(page, directoryPath) {
  const row = directoryRow(page, directoryPath);
  if (await row.count() === 0) return;
  await row.locator('.action-menu-trigger').click();
  const deleteButton = row.getByRole('menuitem', { name: 'Delete', exact: true });
  await expect(deleteButton).toBeVisible({ timeout: smokeConfig.timeouts.action });
  page.once('dialog', async (dialog) => dialog.accept());
  await deleteButton.click();
  await expect(row).toHaveCount(0, { timeout: smokeConfig.timeouts.navigation });
}

export async function openCopilotForDirectory(page, directoryPath) {
  const row = directoryRow(page, directoryPath);
  await row.locator('.action-menu-trigger').click();
  const openCopilot = row.getByRole('menuitem', {
    name: 'Open Copilot here',
    exact: true,
  });
  await expect(openCopilot).toBeVisible({ timeout: smokeConfig.timeouts.navigation });

  const popupPromise = page.waitForEvent('popup', {
    timeout: smokeConfig.timeouts.navigation,
  });
  await openCopilot.click();
  const copilotPage = await popupPromise;
  await copilotPage.waitForLoadState('domcontentloaded');

  const launchUrl = new URL(copilotPage.url());
  expect(launchUrl.pathname).toBe('/webchat');
  expect(launchUrl.searchParams.get('agent')).toBe('roboTeamAgent');
  expect(launchUrl.searchParams.get('robot')).toBe('default');
  expect(launchUrl.searchParams.get('forward-envelope')).toBe('1');
  const requestedDirectory = launchUrl.searchParams.get('workspace-dir')
    || launchUrl.searchParams.get('dir')
    || '';
  const directoryName = directoryPath.split('/').filter(Boolean).at(-1) || '';
  expect(
    requestedDirectory === directoryName
      || requestedDirectory.endsWith(`/${directoryName}`),
    `Copilot launch directory should identify ${directoryPath}; received ${requestedDirectory}`,
  ).toBe(true);
  return copilotPage;
}
