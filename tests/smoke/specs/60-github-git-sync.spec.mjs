import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { openExplorer } from '../lib/explorer.mjs';

test.describe('GitHub Git plugin @external', () => {
  test.skip(!smokeConfig.flags.github, 'Set SMOKE_GITHUB=1 to run GitHub smoke checks.');

  test('Git modal exposes GitHub authentication controls without leaking tokens', async ({ page }) => {
    await openExplorer(page);
    const gitButton = page.getByRole('button', { name: 'Git', exact: true });
    await expect(gitButton).toBeVisible();
    await gitButton.click();
    const dialog = page.getByRole('dialog', { name: 'Git', exact: true });
    await expect(dialog).toBeVisible();
    const settings = dialog.getByRole('button', { name: 'Git settings', exact: true });
    await expect(settings).toBeVisible();
    const credentials = dialog.getByRole('tablist', { name: 'Git credentials sections', exact: true });
    if (!(await credentials.isVisible())) await settings.click();
    await expect(credentials).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'GitHub', exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/ghp_|github_pat_|x-access-token/i);
  });
});
