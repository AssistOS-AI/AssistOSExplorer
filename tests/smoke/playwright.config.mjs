import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { smokeConfig } from './lib/config.mjs';
import { validateQaAcceptanceProfile } from './lib/qa-acceptance-profile.mjs';

const qaAcceptanceProfile = validateQaAcceptanceProfile({
  enabled: smokeConfig.flags.qaAcceptance,
  headed: false,
  baseURL: smokeConfig.baseURL,
  edgeIP: smokeConfig.qaEdgeIP,
});

export const playwrightOutputPaths = Object.freeze({
  htmlReport: path.join(smokeConfig.artifactRoot, 'playwright-report'),
  jsonReport: path.join(smokeConfig.artifactRoot, 'test-results', 'results.json'),
  outputDir: path.join(smokeConfig.artifactRoot, 'test-results'),
});

export default defineConfig({
  testDir: './specs',
  globalSetup: fileURLToPath(new URL('./lib/account-preflight.mjs', import.meta.url)),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: smokeConfig.timeouts.test,
  expect: {
    timeout: smokeConfig.timeouts.expect,
  },
  reporter: [
    ['./lib/redacted-reporter.mjs'],
    [fileURLToPath(new URL('./lib/acceptance-reporter.mjs', import.meta.url))],
    ['list'],
    ['html', { open: 'never', outputFolder: playwrightOutputPaths.htmlReport }],
    ['json', { outputFile: playwrightOutputPaths.jsonReport }],
  ],
  outputDir: playwrightOutputPaths.outputDir,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: smokeConfig.baseURL,
    actionTimeout: smokeConfig.timeouts.action,
    navigationTimeout: smokeConfig.timeouts.navigation,
    screenshot: 'only-on-failure',
    trace: 'off',
    video: smokeConfig.flags.webmeetScreen ? 'retain-on-failure' : 'off',
    ignoreHTTPSErrors: true,
    permissions: ['camera', 'microphone'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--allow-http-screen-capture',
        '--auto-select-desktop-capture-source=Entire screen',
        ...(qaAcceptanceProfile.edgeIP
          ? [`--host-resolver-rules=MAP explorer-qa.axiologic.dev ${qaAcceptanceProfile.edgeIP}`]
          : []),
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
      },
    },
  ],
});
