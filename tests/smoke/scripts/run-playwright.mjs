#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  collectScreenRuntimeEvidence,
  sameScreenRuntimeGeneration,
} from '../lib/screen-runtime-evidence.mjs';
import {
  collectCopilotReleaseEvidence,
  sameCopilotReleaseGeneration,
} from '../lib/copilot-release-evidence.mjs';
import { validateQaAcceptanceProfile } from '../lib/qa-acceptance-profile.mjs';
import { validateHeadlessWebMeetProfile } from '../lib/webmeet-headless-profile.mjs';

const smokeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(smokeRoot, 'node_modules', 'playwright', 'cli.js');
const playwrightArgs = process.argv.slice(2);
const forbiddenOutputOptions = new Set([
  '--config', '-c', '--output', '--reporter',
  '--update-snapshots', '-u', '--update-source-method',
]);
const selectedSpecFiles = playwrightArgs.filter((argument) => (
  /(?:^|\/)specs\/[^/]+\.spec\.mjs$/i.test(String(argument).replaceAll('\\', '/'))
));
const ordinaryCopilotGate = selectedSpecFiles.length === 0
  || selectedSpecFiles.some((argument) => (
    String(argument).replaceAll('\\', '/').endsWith('specs/05-copilot-folder-launch.spec.mjs')
  ));
for (let index = 0; index < playwrightArgs.length; index += 1) {
  const argument = playwrightArgs[index];
  const optionName = String(argument).split('=', 1)[0];
  if (forbiddenOutputOptions.has(optionName)) {
    throw new Error(`Explorer smoke gates forbid Playwright output override '${optionName}'; all artifacts must remain under SMOKE_ARTIFACT_DIR.`);
  }
  const retryValue = argument === '--retries'
    ? playwrightArgs[index + 1]
    : argument.startsWith('--retries=') ? argument.slice('--retries='.length) : null;
  if (retryValue !== null && retryValue !== '0') {
    throw new Error('Explorer smoke gates require exactly zero Playwright retries.');
  }
}
const screenGate = /^(1|true|yes|on)$/i.test(String(process.env.SMOKE_WEBMEET_SCREEN || '').trim());
const headlessWebMeetGate = /^(1|true|yes|on)$/i.test(String(process.env.SMOKE_WEBMEET_HEADLESS || '').trim());
const mediaGate = /^(1|true|yes|on)$/i.test(String(process.env.SMOKE_WEBMEET_MEDIA || '').trim());
const qaAcceptanceGate = /^(1|true|yes|on)$/i.test(String(process.env.SMOKE_QA_ACCEPTANCE || '').trim());
const headed = playwrightArgs.includes('--headed') || playwrightArgs.some((arg) => arg === '--headless=false');
const baseURL = process.env.SMOKE_BASE_URL
  || process.env.PLAYWRIGHT_BASE_URL
  || (qaAcceptanceGate ? 'https://explorer-qa.axiologic.dev' : 'http://127.0.0.1:8080');
const boxBaseURL = String(process.env.SMOKE_BOX_BASE_URL || baseURL).trim();
const verificationMode = String(process.env.SMOKE_SOURCE_VERIFICATION || 'release');
if (!['release', 'local-snapshot'].includes(verificationMode)) {
  throw new Error('SMOKE_SOURCE_VERIFICATION must be release or local-snapshot.');
}
if (qaAcceptanceGate && verificationMode !== 'release') {
  throw new Error('QA acceptance requires release source verification.');
}
const sourceManifestPath = String(verificationMode === 'local-snapshot'
  ? process.env.SMOKE_LOCAL_SNAPSHOT_MANIFEST || ''
  : process.env.SMOKE_RELEASE_MANIFEST || '').trim();
const sourceVerifierPath = path.resolve(smokeRoot, verificationMode === 'local-snapshot'
  ? '../../../ploinky/tests/release/verifyLocalSnapshotBundle.mjs'
  : '../../../ploinky/tests/release/verifyCopilot421Bundle.mjs');

validateHeadlessWebMeetProfile({
  enabled: headlessWebMeetGate,
  headed,
  media: mediaGate,
  screen: screenGate,
});
validateQaAcceptanceProfile({
  enabled: qaAcceptanceGate,
  headed,
  baseURL,
  edgeIP: process.env.SMOKE_QA_EDGE_IP,
});

const sourceGate = spawnSync(
  process.execPath,
  ['--test', 'lib/retired-source-absence.test.mjs'],
  { cwd: smokeRoot, env: process.env, stdio: 'inherit' },
);
if (sourceGate.error) throw sourceGate.error;
if (sourceGate.status !== 0) {
  throw new Error(`Retired-source gate failed with exit ${sourceGate.status ?? 'unknown'}.`);
}

if (screenGate && !headed) {
  throw new Error('SMOKE_WEBMEET_SCREEN requires --headed so Chromium performs real getDisplayMedia capture.');
}
if (!fs.existsSync(cliPath)) {
  throw new Error(`Playwright is not installed at ${cliPath}; run npm install first.`);
}

function executableOnPath(name) {
  for (const entry of String(process.env.PATH || '').split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) {
      // Continue searching PATH.
    }
  }
  return '';
}

function reserveDisplay() {
  for (let number = 99; number <= 109; number += 1) {
    if (fs.existsSync(`/tmp/.X11-unix/X${number}`) || fs.existsSync(`/tmp/.X${number}-lock`)) continue;
    return { number, display: `:${number}` };
  }
  throw new Error('No free deterministic X display is available in :99..:109.');
}

async function waitForSocket(socketPath, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) return;
    if (child.exitCode !== null) {
      throw new Error(`Xvfb exited before creating ${socketPath} (exit ${child.exitCode}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Xvfb did not create ${socketPath} within 5 seconds.`);
}

function terminate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
}

let xvfb = null;
const childEnv = { ...process.env };
for (const name of Object.keys(childEnv)) {
  if (
    /^PLAYWRIGHT_[A-Z0-9]+_OUTPUT_(?:DIR|FILE|NAME)$/.test(name)
    || name === 'PLAYWRIGHT_HTML_REPORT'
    || name === 'PW_TEST_REPORTER'
  ) {
    delete childEnv[name];
  }
}
let screenRuntimeEvidence = null;
let copilotReleaseEvidence = null;
if (ordinaryCopilotGate) {
  copilotReleaseEvidence = await collectCopilotReleaseEvidence({
    manifestPath: sourceManifestPath,
    verifierPath: sourceVerifierPath,
    verificationMode,
    requireActiveAchillesCLI: false,
    baseURL,
    boxBaseURL,
    expectedContainerName: String(process.env.SMOKE_PLOINKY_BOX_CONTAINER || '').trim(),
    expectedImageRef: String(process.env.SMOKE_EXPECT_BOX_IMAGE_REF || '').trim(),
    generationMaxAgeMs: process.env.SMOKE_BOX_MAX_GENERATION_AGE_MS,
    imageMaxAgeMs: process.env.SMOKE_BOX_MAX_IMAGE_AGE_MS,
  });
  childEnv.SMOKE_COPILOT_RELEASE_EVIDENCE = JSON.stringify(copilotReleaseEvidence);
  console.log(`Copilot source verification: ${verificationMode}${verificationMode === 'local-snapshot' ? ' (development evidence; not release acceptance)' : ''}`);
}
if (screenGate) {
  const baseURL = process.env.SMOKE_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8080';
  screenRuntimeEvidence = collectScreenRuntimeEvidence({
    deployment: String(process.env.SMOKE_DEPLOYMENT_MODE || '').trim(),
    baseURL,
    expectedContainerName: process.env.SMOKE_PLOINKY_BOX_CONTAINER,
    expectedImageId: process.env.SMOKE_EXPECT_BOX_IMAGE_ID,
    expectedImageRef: process.env.SMOKE_EXPECT_BOX_IMAGE_REF,
    publicIPv4: process.env.SMOKE_WEBMEET_PUBLIC_IPV4,
    generationMaxAgeMs: process.env.SMOKE_BOX_MAX_GENERATION_AGE_MS,
    imageMaxAgeMs: process.env.SMOKE_BOX_MAX_IMAGE_AGE_MS,
  });
  childEnv.SMOKE_SCREEN_RUNTIME_EVIDENCE = JSON.stringify(screenRuntimeEvidence);
}
if (process.platform === 'linux' && headed && !childEnv.DISPLAY) {
  const xvfbPath = executableOnPath('Xvfb');
  if (!xvfbPath) {
    throw new Error('Headed Linux screen-share smoke requires Xvfb on PATH when DISPLAY is unset.');
  }
  const reserved = reserveDisplay();
  xvfb = spawn(xvfbPath, [
    reserved.display,
    '-screen', '0', '1920x1080x24',
    '-nolisten', 'tcp',
    '-noreset',
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
  childEnv.DISPLAY = reserved.display;
  await waitForSocket(`/tmp/.X11-unix/X${reserved.number}`, xvfb);
}

const playwright = spawn(process.execPath, [cliPath, 'test', ...playwrightArgs], {
  cwd: smokeRoot,
  env: childEnv,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    playwright.kill(signal);
    terminate(xvfb);
  });
}

let exitCode = await new Promise((resolve, reject) => {
  playwright.once('error', reject);
  playwright.once('exit', (code, signal) => {
    if (signal) resolve(1);
    else resolve(code ?? 1);
  });
});
terminate(xvfb);
if (screenRuntimeEvidence) {
  try {
    const boxEvidence = screenRuntimeEvidence.deployment === 'box'
      ? screenRuntimeEvidence.box
      : null;
    const postRunEvidence = collectScreenRuntimeEvidence({
      deployment: screenRuntimeEvidence.deployment,
      baseURL: screenRuntimeEvidence.baseURL,
      expectedContainerName: boxEvidence?.box.containerName,
      expectedImageId: boxEvidence?.box.imageId,
      expectedImageRef: boxEvidence?.box.imageRef,
      publicIPv4: boxEvidence?.box.publicIPv4,
      generationMaxAgeMs: boxEvidence?.generationMaxAgeMs,
      imageMaxAgeMs: boxEvidence?.imageMaxAgeMs,
    });
    if (!sameScreenRuntimeGeneration(screenRuntimeEvidence, postRunEvidence)) {
      throw new Error('The exact deployment generation changed during the screen-share smoke gate.');
    }
  } catch (error) {
    console.error(`Post-screen runtime evidence failed: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  }
}
if (copilotReleaseEvidence) {
  try {
    const postRunEvidence = await collectCopilotReleaseEvidence({
      manifestPath: sourceManifestPath,
      verifierPath: sourceVerifierPath,
      verificationMode,
      requireActiveAchillesCLI: true,
      baseURL,
      boxBaseURL,
      expectedContainerName: copilotReleaseEvidence.liveBox.box.containerName,
      expectedImageRef: copilotReleaseEvidence.liveBox.box.imageRef,
      generationMaxAgeMs: process.env.SMOKE_BOX_MAX_GENERATION_AGE_MS,
      imageMaxAgeMs: process.env.SMOKE_BOX_MAX_IMAGE_AGE_MS,
    });
    if (!sameCopilotReleaseGeneration(copilotReleaseEvidence, postRunEvidence)) {
      throw new Error('The exact manifest-bound Box generation changed during the ordinary Copilot gate.');
    }
  } catch (error) {
    console.error(`Post-Copilot release evidence failed: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  }
}
process.exitCode = exitCode;
