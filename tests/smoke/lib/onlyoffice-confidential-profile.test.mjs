import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const smokeRoot = fileURLToPath(new URL('../', import.meta.url));
const expectedTitle = 'Explorer-created Confidential document saves through callback, drains, and reopens after targeted restart';

test('npm Confidential OnlyOffice profile owns the exact single-test selector', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const command = packageJson.scripts?.['test:onlyoffice-confidential'];
  assert.equal(typeof command, 'string');
  assert.match(command, /\bSMOKE_ONLYOFFICE=1\b/);
  assert.match(command, /--project=chromium\b/);
  assert.match(command, /--workers=1\b/);
  assert.match(command, /--retries=0\b/);
  assert.match(command, new RegExp(`--grep ['\"]${expectedTitle}['\"]`));
  assert.match(command, /\bspecs\/50-onlyoffice-dpu\.spec\.mjs\b/);
  assert.doesNotMatch(command, /--grep\s+['\"]?\^/);

  const onlyOfficeSpec = fs.readFileSync(
    new URL('../specs/50-onlyoffice-dpu.spec.mjs', import.meta.url),
    'utf8',
  );
  assert.match(onlyOfficeSpec, new RegExp(`test\\(['\"]${expectedTitle}['\"]`));
  assert.match(onlyOfficeSpec, /const fileName = `smoke-onlyoffice-\$\{smokeConfig\.runId\}\.docx`;/);
  assert.match(onlyOfficeSpec, /const documentPath = `\/Confidential\/My Space\/\$\{fileName\}`;/);
  // The single selected test is the narrow regression path, so it owns the
  // OnlyOffice document file-type assertion the QA acceptance profile got wrong.
  assert.match(onlyOfficeSpec, /expect\(payload\.config\)\.toMatchObject\(\{/);
  assert.match(onlyOfficeSpec, /fileType: 'docx',/);
  assert.doesNotMatch(onlyOfficeSpec, /fileType: 'doc',/);
  // DPU names are unique only among siblings, so every durable assertion is
  // keyed on the object ID this run created.
  assert.match(onlyOfficeSpec, /const preExistingIds = new Set\(listDpuFileObjects\(\)\.map\(\(object\) => object\.id\)\);/);
  assert.match(onlyOfficeSpec, /createdObjectId = dpuObject\.id;/);
  assert.doesNotMatch(onlyOfficeSpec, /readDpuObjectSnapshot\(fileName\)/);
  // The created Confidential document must not survive the run, and cleanup
  // must never replace the original failure.
  assert.match(onlyOfficeSpec, /deleteConfidentialDocument\(page, documentPath, createdObjectId\)/);
  assert.match(onlyOfficeSpec, /\} finally \{\s+await finalizeOnlyOfficeGate\(\{/);
  assert.match(onlyOfficeSpec, /failureCollector\.throwIfAny\(\{ primaryError, label: 'OnlyOffice Confidential release gate' \}\)/);
});

test('Confidential OnlyOffice selector collects exactly one Playwright test', { timeout: 30_000 }, () => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyoffice-selector-'));
  try {
    const result = spawnSync(
      'npm',
      ['run', 'test:onlyoffice-confidential', '--', '--list'],
      {
        cwd: smokeRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          SMOKE_ARTIFACT_DIR: artifactRoot,
          SMOKE_RUN_ID: 'onlyoffice-selector-contract',
        },
        timeout: 20_000,
      },
    );
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /50-onlyoffice-dpu\.spec\.mjs:\d+:\d+.*Explorer-created Confidential document saves through callback, drains, and reopens after targeted restart/);
    assert.match(output, /Total: 1 test in 1 file/);
    assert.doesNotMatch(output, /No tests found/);
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
});
