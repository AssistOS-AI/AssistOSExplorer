import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url), 'utf8');

function block(name) {
    const match = workflow.match(new RegExp(`// BEGIN QA ${name}\\n([\\s\\S]*?)// END QA ${name}`));
    assert.ok(match, `Missing ${name} implementation`);
    return match[1].replace(/^ {10}/gm, '');
}

test('prior selections are classified and logged against the fresh graph, and none is enabled', () => {
    const selection = block('prior selection restoration');
    assert.doesNotMatch(selection, /enable:|restorePriorSelections|enableArguments/);
    assert.match(selection, /classifyPriorSelections\(authority\.agents, registry\)/);
    assert.match(selection, /describeSelectionDispositions\(classification\)/);
    assert.match(selection, /adapters\.ready\(current, \{ \.\.\.authority, agents: \[\] \}\)/);
    assert.match(selection, /Prior agent choices restored and checked against the fresh runtime\./);
    assert.ok(workflow.indexOf('// BEGIN QA prior selection restoration') < workflow.indexOf('Verified $repository_name/$expected_branch at'));
});

// A block's own imports sit above its marker, so the check prepends the ones it uses.
function assertParses(t, name, source) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-redeploy-block-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'block.mjs');
    fs.writeFileSync(file, source);
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(checked.status, 0, `${name}: ${checked.stderr}`);
}

test('the rewritten selection block is valid module code', t => {
    assertParses(t, 'prior selection restoration', `import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
${block('prior selection restoration')}`);
});
