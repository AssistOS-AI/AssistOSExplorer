import { expect } from '@playwright/test';

import { smokeConfig } from './config.mjs';
import { openExplorer } from './explorer.mjs';

function userRow(page, email) {
  const escapedEmail = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.getByRole('region', { name: new RegExp(`^${escapedEmail}$`, 'i') });
}

async function completeUserAction(page, action, args, click) {
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request();
    if (request.method() !== 'POST'
      || !new URL(response.url()).pathname.endsWith(`/dashboard/api/admin/users/${action}`)) {
      return false;
    }
    const payload = request.postDataJSON();
    return Object.entries(args).every(([key, value]) => payload?.[key] === value);
  }, { timeout: smokeConfig.timeouts.navigation });
  const [response] = await Promise.all([responsePromise, click()]);
  expect(response.ok(), `User administration ${action} must succeed.`).toBe(true);
  const payload = await response.json();
  expect(payload.ok).toBe(true);
  expect(payload.result?.ok).not.toBe(false);
}

async function expectUsersLoaded(page) {
  await expect(page.locator('#usersPageLabel')).toHaveText(/^\d+–\d+ of \d+ users$/, {
    timeout: smokeConfig.timeouts.navigation,
  });
  await expect(page.locator('#userpersistoStatus')).not.toHaveClass(/\berror\b/);
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

  const usersLink = dialog.locator('a[data-account-capability="admin.users.manage"]');
  await expect(usersLink).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
  const target = new URL(await usersLink.getAttribute('href'), page.url());
  const popupPromise = page.waitForEvent('popup', { timeout: smokeConfig.timeouts.navigation });
  const [usersPage] = await Promise.all([popupPromise, usersLink.click()]);
  await usersPage.waitForURL((url) => url.origin === target.origin && url.pathname === target.pathname, {
    timeout: smokeConfig.timeouts.navigation,
  });
  await expect(usersPage.locator('#management-controls')).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
  await expect(usersPage.locator('#management-controls')).toBeEnabled();
  await expectUsersLoaded(usersPage);
  return usersPage;
}

async function searchUsers(page, email) {
  await page.locator('#userSearchInput').fill(email);
  await completeUserAction(page, 'list', { search: email }, () => (
    page.getByRole('button', { name: 'Search', exact: true }).click()
  ));
  await expectUsersLoaded(page);
}

async function saveUser(page, row, action, status) {
  const userId = await row.getAttribute('data-user-id');
  await completeUserAction(page, action, { userId }, () => (
    row.locator(`[data-user-action="${action === 'update' ? 'details' : 'roles'}"]`).click()
  ));
  await expect(page.locator('#userpersistoStatus')).toHaveText(status, {
    timeout: smokeConfig.timeouts.navigation,
  });
}

// Accounts already exist after signing in; public sign-ups initially have only
// selfRegistered. Choose the complete role set so that role does not linger.
export async function assignRoleThroughAdministration(page, account, { name = '', role = 'user' } = {}) {
  const email = String(account.loginEmail || '').trim();
  if (!email) throw new Error('Role assignment needs the account sign-in email.');
  await searchUsers(page, email);
  const row = userRow(page, email);
  await expect(row).toHaveCount(1, { timeout: smokeConfig.timeouts.navigation });
  const userId = await row.getAttribute('data-user-id');
  if (name) {
    await row.locator('input[data-user-field="displayName"]').fill(name);
    await saveUser(page, row, 'update', 'User details saved.');
  }

  await expect(row.getByRole('checkbox', { name: role, exact: true })).toHaveCount(1);
  for (const checkbox of await row.locator('input[data-user-role]').all()) {
    await checkbox.setChecked(await checkbox.inputValue() === role);
  }
  await saveUser(page, row, 'roles', 'User roles saved.');
  await searchUsers(page, email);
  const savedRow = userRow(page, email);
  await expect(savedRow).toHaveCount(1, { timeout: smokeConfig.timeouts.navigation });
  await expect(savedRow).toHaveAttribute('data-user-id', userId);
  await expect(savedRow.locator('input[data-user-role]:checked')).toHaveCount(1);
  await expect(savedRow.getByRole('checkbox', { name: role, exact: true })).toBeChecked();
  if (name) await expect(savedRow.locator('input[data-user-field="displayName"]')).toHaveValue(name);
  return userId;
}

// Cleanup blocks the account and retains its identity and sign-in history.
export async function deleteUserThroughAdministrationIfPresent(page, account) {
  const email = String(account?.loginEmail || '').trim();
  if (!email) return false;
  await searchUsers(page, email);
  const row = userRow(page, email);
  if (await row.count() === 0) return false;
  await expect(row).toHaveCount(1);
  const userId = await row.getAttribute('data-user-id');
  await row.locator('select[data-user-field="status"]').selectOption('blocked');
  await saveUser(page, row, 'update', 'User details saved.');
  await searchUsers(page, email);
  const savedRow = userRow(page, email);
  await expect(savedRow).toHaveCount(1, { timeout: smokeConfig.timeouts.navigation });
  await expect(savedRow).toHaveAttribute('data-user-id', userId);
  await expect(savedRow.locator('select[data-user-field="status"]')).toHaveValue('blocked');
  return true;
}
