import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { expect } from './fixtures.mjs';
import { signIn } from './auth.mjs';
import { smokeConfig } from './config.mjs';
import { callAgentToolViaRouter } from './mcp.mjs';
import { observeWebchatCleanup, WEBCHAT_FIXTURE_DOCUMENT } from './webchat-cleanup.mjs';

// explorer/tools/explorer_tool.mjs preserves empty text across its stdout wire.
const EXPLORER_EMPTY_TEXT_SENTINEL = '__ASSISTOS_EXPLORER_EMPTY_TEXT__';

export function taggedWebchatPath(workspaceDirectory = '.') {
  const params = new URLSearchParams({
    agent: smokeConfig.webchatAgent,
    robot: 'default',
    'forward-envelope': '1',
    'workspace-dir': workspaceDirectory,
  });
  return `/webchat?${params.toString()}`;
}

export async function openTaggedWebchat(page, account = smokeConfig.primaryUser, workspaceDirectory = '.') {
  await signIn(page, account, taggedWebchatPath(workspaceDirectory));
  await expect(page.locator('#cmd')).toBeVisible();
  await cancelWebchatGenerationIfActive(page);
  await waitForWebchatIdle(page);
}

export async function withWebchatUploadProject(page, run, {
  signInFn = signIn,
  callTool = callAgentToolViaRouter,
} = {}) {
  const runId = smokeConfig.runId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
  const directory = `webchat-upload-${runId}-${crypto.randomUUID()}`;
  // Use an inert same-origin document for authenticated fixture MCP calls.
  // No chat starts at the workspace root and no credential response is rendered.
  await signInFn(page, smokeConfig.primaryUser, WEBCHAT_FIXTURE_DOCUMENT);
  const created = await callTool(page, {
    agent: 'explorer', tool: 'create_directory', args: {path: directory},
  });
  expect(created.rawText).toMatch(/^Successfully created directory /);
  const cleanup = observeWebchatCleanup(page, directory);
  try {
    const contents = await callTool(page, {
      agent: 'explorer', tool: 'list_directory', args: {path: directory},
      expectedRawText: EXPLORER_EMPTY_TEXT_SENTINEL,
    });
    expect(contents, 'a fresh project must have the exact routed empty-directory response').toEqual({
      rawText: EXPLORER_EMPTY_TEXT_SENTINEL,
    });
    await run(directory);
  } finally {
    try {
      await cleanup.quiesce();
      const removed = await callTool(page, {
        agent: 'explorer', tool: 'delete_directory', args: {path: directory},
      });
      expect(removed.rawText).toMatch(/^Successfully deleted directory /);
    } finally {
      cleanup.dispose();
    }
  }
}

export async function waitForWebchatIdle(page, timeout = smokeConfig.timeouts.navigation) {
  await expect(page.locator('#typingIndicator')).toHaveAttribute('aria-hidden', 'true', { timeout });
  await expect(page.locator('#cancelBtn')).toBeHidden({ timeout });
  await expect(page.locator('#send')).toBeVisible();
}

export async function cancelWebchatGenerationIfActive(page, {timeout = smokeConfig.timeouts.navigation} = {}) {
  await page.waitForTimeout(1_000);
  const cancelButton = page.locator('#cancelBtn');
  const active = await cancelButton.isVisible({ timeout: 2_000 }).catch(() => false);
  if (!active) return;
  const current = new URL(page.url());
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => {
      const url = new URL(candidate.url());
      return url.origin === current.origin && url.pathname === '/webchat/control'
        && candidate.request().method() === 'POST' && candidate.request().postData() === '\x1b'
        && url.searchParams.get('agent') === current.searchParams.get('agent')
        && url.searchParams.get('workspace-dir') === current.searchParams.get('workspace-dir');
    }, {timeout}),
    cancelButton.click(),
  ]);
  expect(response.status(), 'WebChat cancellation must be accepted before cleanup').toBe(204);
  let timer;
  try {
    const completed = await Promise.race([
      response.finished(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('WebChat cancellation response did not finish before cleanup.')), timeout);
      }),
    ]);
    expect(completed, 'WebChat cancellation response must finish before cleanup').toBeNull();
  } finally {
    clearTimeout(timer);
  }
  await waitForWebchatIdle(page);
}

async function captureNextUploadResponse(page) {
  const pattern = '**/uploads**';
  let handler;
  const promise = new Promise((resolve, reject) => {
    handler = async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }

      try {
        const response = await route.fetch();
        const body = await response.text();
        let payload = null;
        try {
          payload = JSON.parse(body);
        } catch (error) {
          reject(error);
        }
        resolve({ status: response.status(), payload, body });
        await route.fulfill({ response, body });
      } catch (error) {
        reject(error);
        await route.abort().catch(() => {});
      } finally {
        await page.unroute(pattern, handler).catch(() => {});
      }
    };
  });
  await page.route(pattern, handler);
  return promise;
}

export async function setComposer(page, value) {
  await page.locator('#cmd').focus();
  await page.locator('#cmd').fill(value);
  await page.locator('#cmd').evaluate((input) => {
    input.selectionStart = input.value.length;
    input.selectionEnd = input.value.length;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export async function expectWebchatSuggestion(page, { group, text }) {
  await expect(page.locator('.wa-slash-menu')).toBeVisible();
  if (group) {
    await expect(page.locator('.wa-slash-menu-group', { hasText: group })).toBeVisible();
  }
  await expect(page.locator('.wa-slash-menu-item', { hasText: text }).first()).toBeVisible();
}

export async function expectNoWebchatSuggestion(page, text) {
  await page.waitForTimeout(1_000);
  await expect(page.locator('.wa-slash-menu-item', { hasText: text })).toHaveCount(0);
}

export async function selectActiveWebchatSuggestion(page) {
  await page.keyboard.press('Enter');
}

export async function selectWebchatWorkspacePath(page, relativePath) {
  const segments = relativePath.split('/');
  await setComposer(page, `@${segments[0]}`);
  for (let index = 0; index < segments.length; index += 1) {
    const prefix = segments.slice(0, index + 1).join('/');
    const folder = index < segments.length - 1;
    await expectWebchatSuggestion(page, {
      group: 'Files and folders', text: `${prefix}${folder ? '/' : ''}`,
    });
    const label = `${prefix}${folder ? '/' : ''}`;
    const exactLabel = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    await page.locator('.wa-slash-menu-item').filter({
      has: page.locator('.wa-slash-menu-label', {hasText: exactLabel}),
    }).click();
    await expect(page.locator('#cmd')).toHaveValue(`@${prefix}${folder ? '/' : ' '}`);
  }
}

async function confirmDefaultUploadDestination(page) {
  const dialog = page.getByRole('dialog', { name: 'Choose upload destination' });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole('button', { name: 'Upload here' });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toBeHidden();
}

export async function uploadOneFile(page, testInfo, name = `smoke-${smokeConfig.runId}.txt`, workspaceDirectory = '.') {
  const fixtureDir = testInfo.outputPath('fixtures');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const filePath = path.join(fixtureDir, name);
  fs.writeFileSync(filePath, `smoke upload ${smokeConfig.runId}\n`);

  await page.locator('#fileUploadInput').setInputFiles(filePath);
  await confirmDefaultUploadDestination(page);
  await expect(page.locator('.wa-file-preview-name', { hasText: name })).toBeVisible();

  const responsePromise = captureNextUploadResponse(page);
  await page.locator('#send').click();
  const { status, payload } = await responsePromise;
  expect(status, `WebChat upload failed: ${payload?.error || 'unknown error'}`).toBe(201);
  expect(payload.relativePath).toBe(name);
  const workspacePath = path.posix.join(workspaceDirectory, name);
  expect(payload.workspacePath).toBe(workspacePath);
  expect(payload.downloadUrl).toBe(`/workspace-files/${workspacePath.split('/').map(encodeURIComponent).join('/')}`);
  await cancelWebchatGenerationIfActive(page);
  return { filePath, name, payload };
}

export async function uploadFolder(page, testInfo, folderName = `smoke-folder-${smokeConfig.runId}`, workspaceDirectory = '.') {
  const fixtureRoot = testInfo.outputPath('fixtures');
  const folderPath = path.join(fixtureRoot, folderName);
  fs.mkdirSync(path.join(folderPath, 'nested'), { recursive: true });
  const leafName = 'folder-note.txt';
  const relativePath = `${folderName}/nested/${leafName}`;
  fs.writeFileSync(path.join(folderPath, 'nested', leafName), `smoke folder upload ${smokeConfig.runId}\n`);

  await page.locator('#folderUploadInput').setInputFiles(folderPath);
  await confirmDefaultUploadDestination(page);
  await expect(page.locator('.wa-file-preview-name', { hasText: relativePath })).toBeVisible();

  const responsePromise = captureNextUploadResponse(page);
  await page.locator('#send').click();
  const { status, payload } = await responsePromise;
  expect(status, `WebChat upload failed: ${payload?.error || 'unknown error'}`).toBe(201);
  expect(payload.relativePath).toBe(relativePath);
  const workspacePath = path.posix.join(workspaceDirectory, relativePath);
  expect(payload.workspacePath).toBe(workspacePath);
  expect(payload.downloadUrl).toBe(`/workspace-files/${workspacePath.split('/').map(encodeURIComponent).join('/')}`);
  await cancelWebchatGenerationIfActive(page);
  return { folderPath, folderName, relativePath, payload };
}
