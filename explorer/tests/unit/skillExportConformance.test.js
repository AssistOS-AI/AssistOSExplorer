import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as explorer from '../../utils/server/skill-export-transaction.mjs';
import * as explorerExclusions from '../../utils/server/skill-export-exclusions.mjs';
import { scenarios, contentionScenario } from './skillExportConformanceScenarios.mjs';

const PROTOCOL = 'cli/utils/skills/exportTransaction.mjs';
const EXCLUSIONS = 'cli/utils/skills/exportExclusions.mjs';
const SCENARIOS = 'tests/unit/fixtures/skillExportConformanceScenarios.mjs';

const temporary = (t) => (label) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `explorer-skill-tx-${label}-`)));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

// Ploinky owns the paired copy; EXPLORER_TEST_PLOINKY_CHECKOUT points isolated
// test copies at it.
function ploinkyCheckout() {
  const candidates = [
    process.env.EXPLORER_TEST_PLOINKY_CHECKOUT,
    fileURLToPath(new URL('../../../../ploinky', import.meta.url))
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, PROTOCOL))) || null;
}

const ploinkyRoot = ploinkyCheckout();
const ploinky = ploinkyRoot ? await import(pathToFileURL(path.join(ploinkyRoot, PROTOCOL)).href) : null;
const skipReason = 'Ploinky checkout not present (set EXPLORER_TEST_PLOINKY_CHECKOUT)';

for (const scenario of scenarios) {
  test(`explorer protocol: ${scenario.name}`, (t) => scenario.run({ mod: explorer, exclusions: explorerExclusions, tmp: temporary(t) }));
}

test('two Explorer exporter instances exclude and recover each other on one folder', (t) => {
  contentionScenario({ first: explorer, second: explorer, tmp: temporary(t) });
});

test('Ploinky protocol and conformance scenarios are byte-identical paired copies', (t) => {
  if (!ploinkyRoot) { t.skip(skipReason); return; }
  const local = (file) => fs.readFileSync(fileURLToPath(new URL(file, import.meta.url)));
  assert.ok(local('../../utils/server/skill-export-transaction.mjs').equals(fs.readFileSync(path.join(ploinkyRoot, PROTOCOL))));
  assert.ok(local('./skillExportConformanceScenarios.mjs').equals(fs.readFileSync(path.join(ploinkyRoot, SCENARIOS))));
  assert.ok(local('../../utils/server/skill-export-exclusions.mjs').equals(fs.readFileSync(path.join(ploinkyRoot, EXCLUSIONS))));
});

test('Explorer and Ploinky exporters exclude and recover each other on one folder', (t) => {
  if (!ploinky) { t.skip(skipReason); return; }
  contentionScenario({ first: explorer, second: ploinky, tmp: temporary(t) });
  contentionScenario({ first: ploinky, second: explorer, tmp: temporary(t) });
});
