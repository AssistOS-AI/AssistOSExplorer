import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

function isDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

test('every Playwright output is rooted beneath SMOKE_ARTIFACT_DIR', async () => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-playwright-output-'));
  const previous = process.env.SMOKE_ARTIFACT_DIR;
  process.env.SMOKE_ARTIFACT_DIR = artifactRoot;
  try {
    const moduleUrl = new URL(`../playwright.config.mjs?artifact-test=${Date.now()}`, import.meta.url);
    const { default: config, playwrightOutputPaths } = await import(moduleUrl.href);
    assert.equal(config.reporter[0][0], './lib/redacted-reporter.mjs', 'redaction must precede every built-in reporter');
    const html = config.reporter.find(([name]) => name === 'html')[1].outputFolder;
    const json = config.reporter.find(([name]) => name === 'json')[1].outputFile;
    assert.deepEqual([html, json, config.outputDir], [
      playwrightOutputPaths.htmlReport,
      playwrightOutputPaths.jsonReport,
      playwrightOutputPaths.outputDir,
    ]);
    for (const outputPath of [html, json, config.outputDir]) {
      assert.equal(path.isAbsolute(outputPath), true, outputPath);
      assert.equal(isDescendant(artifactRoot, outputPath), true, outputPath);
    }
  } finally {
    if (previous === undefined) delete process.env.SMOKE_ARTIFACT_DIR;
    else process.env.SMOKE_ARTIFACT_DIR = previous;
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('the canonical runner rejects every CLI output escape before Playwright starts', () => {
  const smokeRoot = path.resolve(import.meta.dirname, '..');
  const runner = path.join(smokeRoot, 'scripts', 'run-playwright.mjs');
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-playwright-runner-'));
  try {
    for (const override of [
      `--output=${path.join(artifactRoot, '..', 'escaped-output')}`,
      '--reporter=line',
      `--config=${path.join(artifactRoot, '..', 'foreign.config.mjs')}`,
      '--update-snapshots=all',
      '-u',
    ]) {
      const result = spawnSync(process.execPath, [runner, override, '--list'], {
        cwd: smokeRoot,
        env: { ...process.env, SMOKE_ARTIFACT_DIR: artifactRoot },
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0, override);
      assert.match(`${result.stdout}\n${result.stderr}`, /all artifacts must remain under SMOKE_ARTIFACT_DIR/, override);
    }
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('the canonical runner clears inherited Playwright reporter output escapes', () => {
  const smokeRoot = path.resolve(import.meta.dirname, '..');
  const runner = path.join(smokeRoot, 'scripts', 'run-playwright.mjs');
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-playwright-env-'));
  const escapeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-playwright-escape-'));
  const escapedJson = path.join(escapeRoot, 'escaped.json');
  const escapedHtml = path.join(escapeRoot, 'escaped-html');
  const escapedBlob = path.join(escapeRoot, 'escaped.zip');
  try {
    const result = spawnSync(
      process.execPath,
      [runner, 'specs/33-umami-routing.spec.mjs', '--list'],
      {
        cwd: smokeRoot,
        env: {
          ...process.env,
          SMOKE_ARTIFACT_DIR: artifactRoot,
          SMOKE_UMAMI: '1',
          PLAYWRIGHT_JSON_OUTPUT_FILE: escapedJson,
          PLAYWRIGHT_HTML_REPORT: escapedHtml,
          PLAYWRIGHT_BLOB_OUTPUT_FILE: escapedBlob,
          PW_TEST_REPORTER: 'blob',
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(escapedJson), false);
    assert.equal(fs.existsSync(escapedHtml), false);
    assert.equal(fs.existsSync(escapedBlob), false);
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    fs.rmSync(escapeRoot, { recursive: true, force: true });
  }
});
