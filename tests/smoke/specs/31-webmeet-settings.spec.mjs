import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import {
  createRoom,
  deleteRoomIfPresent,
  joinRoom,
  openWebMeet,
  webMeetSurface,
} from '../lib/webmeet.mjs';

async function expectCustomSelectValue(locator, expectedValue) {
  await expect.poll(
    () => locator.evaluate((element) => element.value),
    { timeout: 12000 },
  ).toBe(expectedValue);
}

async function selectCustomOption(locator, optionsRoot, value) {
  await locator.locator('.custom-select').click();
  const optionsList = optionsRoot.locator(':scope > .custom-select-options-list:not(.hidden)');
  await expect(optionsList).toHaveCount(1);
  const option = optionsList.locator(`.custom-select-option[data-value="${value}"]`);
  await expect(option).toBeVisible();
  await option.click();
  await expectCustomSelectValue(locator, value);
}

test.describe('WebMeet settings', () => {
  test('dashboard header exposes audio/video and privacy settings', async ({ page }) => {
    const roomTitle = `e2e-settings-panel-${smokeConfig.runId}`;
    try {
      await openWebMeet(page);
      await createRoom(page, roomTitle);
      await joinRoom(page, roomTitle);

      const settingsButton = webMeetSurface(page).locator('#webmeetMediaSettingsButton');
      await expect(settingsButton).toBeVisible();

      await settingsButton.click();

      const settingsPanel = webMeetSurface(page).locator('#webmeetMediaSettingsPanel');
      await expect(settingsPanel).toBeVisible();
      const settingsDialog = webMeetSurface(page).locator('dialog.webmeet-settings-modal-dialog');
      await expect(settingsDialog).toBeVisible();
      await webMeetSurface(page).locator('#webmeetSettingsFullscreenButton').click();
      await expect(settingsDialog).toHaveClass(/is-fullscreen/);
      await expect(settingsPanel).toContainText('Audio & video');
      await expect(settingsPanel).toContainText('Camera background');
      await expect(settingsPanel).toContainText('Avatar');
      const voiceProcessingSelect = webMeetSurface(page).locator('#webmeetVoiceProcessingMode');
      await expectCustomSelectValue(voiceProcessingSelect, 'auto');
      await expect(voiceProcessingSelect.locator('.custom-select-option').first()).toHaveText('Voice Focus, recommended');
      await expect(webMeetSurface(page).locator('#webmeetAutomaticParticipantVolume')).toBeChecked();
      await expect(webMeetSurface(page).locator('#webmeetAudioHealthIndicator')).toHaveAttribute('data-health', 'good');
      await expect(webMeetSurface(page).locator('#webmeetMicButton')).toHaveAttribute('title', 'Toggle Microphone - Audio: Good');

      const effectSelect = webMeetSurface(page).locator('#webmeetBackgroundEffectSelect');
      await expect(effectSelect).toBeVisible();

      await selectCustomOption(effectSelect, settingsDialog, 'blur');
      await expect(webMeetSurface(page).locator('#webmeetBackgroundBlurRow')).toBeVisible();

      await selectCustomOption(effectSelect, settingsDialog, 'image');
      await expect(webMeetSurface(page).locator('#webmeetBackgroundImageRow')).toBeVisible();
    } finally {
      await deleteRoomIfPresent(page, roomTitle).catch(() => null);
    }
  });

  test('settings controls expose inline help on hover and focus', async ({ page }) => {
    const roomTitle = `e2e-settings-help-${smokeConfig.runId}`;
    try {
      await openWebMeet(page);
      await createRoom(page, roomTitle);
      await joinRoom(page, roomTitle);

      await webMeetSurface(page).locator('#webmeetMediaSettingsButton').click();

      const voiceProcessingHelpButton = webMeetSurface(page).getByRole('button', { name: 'About Voice processing' });
      const voiceProcessingTooltip = webMeetSurface(page).locator('#webmeetSettingHelpVoiceProcessing');
      await voiceProcessingHelpButton.hover();
      await expect(voiceProcessingTooltip).toBeVisible();

      const echoHelpButton = webMeetSurface(page).getByRole('button', { name: 'About Echo cancellation' });
      const echoTooltip = webMeetSurface(page).locator('#webmeetSettingHelpEchoCancellation');
      await echoHelpButton.focus();
      await expect(echoTooltip).toBeVisible();
    } finally {
      await deleteRoomIfPresent(page, roomTitle).catch(() => null);
    }
  });
});
