import { expect } from '@playwright/test';

import { smokeConfig } from './config.mjs';
import { openExplorer } from './explorer.mjs';

function escapeCssAttributeValue(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

// Rows are located by sign-in email: passwordless accounts created by signing
// in may have no username.
function userRow(dialog, email) {
  return dialog.locator('admin-users-settings tr[data-user-id]').filter({
    has: dialog.page().locator('td[data-label="Email"]', { hasText: new RegExp(`^\\s*${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') }),
  });
}

async function expectDropdownAnchored(trigger, optionsList) {
  const [triggerBox, optionsBox] = await Promise.all([
    trigger.boundingBox(),
    optionsList.boundingBox(),
  ]);
  expect(triggerBox).not.toBeNull();
  expect(optionsBox).not.toBeNull();

  const tolerance = 2;
  expect(Math.abs(optionsBox.x - triggerBox.x)).toBeLessThanOrEqual(tolerance);
  const opensBelow = Math.abs(optionsBox.y - (triggerBox.y + triggerBox.height + 4)) <= tolerance;
  const opensAbove = Math.abs((optionsBox.y + optionsBox.height + 4) - triggerBox.y) <= tolerance;
  expect(opensBelow || opensAbove).toBe(true);
}

export async function openAdminUsers(page) {
  await openExplorer(page, { account: smokeConfig.primaryUser });
  await page.locator('#accountMenuButton').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();

  const dialog = page.locator('dialog.settings-modal-dialog');
  await expect(dialog).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
  const administrationTab = dialog.getByRole('tab', { name: 'Administration' });
  await expect(administrationTab).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
  await administrationTab.click();

  // Accounts are created by signing in; administration only searches and edits them.
  await expect(dialog.locator('admin-users-settings form[data-role="searchForm"]')).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
  await expect(dialog.locator('admin-settings-panel [data-role="status"]')).toContainText(
    /\d+ users? loaded\./i,
    { timeout: smokeConfig.timeouts.navigation }
  );
  return dialog;
}

async function searchUsers(dialog, email) {
  const search = dialog.locator('admin-users-settings form[data-role="searchForm"]');
  await search.locator('input[data-role="userSearch"]').fill(email);
  await search.getByRole('button', { name: 'Search', exact: true }).click();
}

// Grants a role to an account that already exists because it signed in (new
// public sign-ups start with the restricted selfRegistered role).
export async function assignRoleThroughAdministration(dialog, account, { name = '', role = 'user' } = {}) {
  const email = String(account.loginEmail || '').trim();
  if (!email) throw new Error('Role assignment needs the account sign-in email.');
  await searchUsers(dialog, email);
  const row = userRow(dialog, email);
  await expect(row).toHaveCount(1, { timeout: smokeConfig.timeouts.navigation });
  if (name) await row.locator('input[data-field="name"]').fill(name);

  const roles = row.locator('custom-select[data-field="roles"]');
  const currentRole = roles.locator('.current-option');
  await expect(currentRole).not.toHaveText('');
  if ((await currentRole.innerText()).trim().toLowerCase() !== role.toLowerCase()) {
    const trigger = roles.locator('.custom-select');
    await trigger.click();
    const optionsList = dialog.locator(':scope > .custom-select-options-list:not(.hidden)');
    await expect(optionsList).toHaveCount(1);
    const roleOption = optionsList.locator(
      `button.option[data-value="${escapeCssAttributeValue(role)}"]`
    );
    await expect(roleOption).toBeVisible();
    await expectDropdownAnchored(trigger, optionsList);
    await roleOption.click();
  }
  await expect(currentRole).toHaveText(role);
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.locator('admin-settings-panel [data-role="status"]')).not.toContainText(/fail|error/i, { timeout: smokeConfig.timeouts.navigation });
  await searchUsers(dialog, email);
  await expect(userRow(dialog, email).locator('custom-select[data-field="roles"] .current-option')).toHaveText(role, { timeout: smokeConfig.timeouts.navigation });
  return row.getAttribute('data-user-id');
}

// Administration "Delete" blocks the account; it never deletes sign-in history.
export async function deleteUserThroughAdministrationIfPresent(dialog, account) {
  const email = String(account?.loginEmail || '').trim();
  if (!email) return false;
  await searchUsers(dialog, email);
  const row = userRow(dialog, email);
  if (await row.count() === 0) return false;
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(row).toHaveCount(0, { timeout: smokeConfig.timeouts.navigation });
  return true;
}
