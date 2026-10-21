import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { BACKUP_INNER_ENTRIES, BACKUP_SIBLING_SUFFIXES } from '../../../.github/scripts/qa-backups.mjs';

const WORKFLOW = new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url);
const ROLLBACK_HELPER = new URL('../../../.github/scripts/rollback-explorer-qa.mjs', import.meta.url);
const JOURNAL_TEMPORARY = /^rollback-result\.json\.[a-f0-9]{16}$/;
const LITERAL = /[A-Za-z0-9._-]+/.source;

/**
 * Every name the deploy workflow and the rollback helper write inside a backup
 * (`inner`) or beside it as `<backup>-<suffix>` (`siblings`). Dynamic forms are
 * accepted only where their names are enumerable from the same text.
 */
function extractBackupWrites(workflow, helper) {
    const inner = new Set(), siblings = new Set();
    // The lock receipts move inside through one loop over a literal suffix list.
    const loops = [...workflow.matchAll(/for suffix in ([^;\n]+); do\n\s*if \[ -f "\$QA_BACKUP_DIR-\$suffix" \]; then mv "\$QA_BACKUP_DIR-\$suffix" "\$QA_BACKUP_DIR\/\$suffix"; fi/g)];
    assert.equal(loops.length, 1, 'exactly one lock-receipt move loop');
    for (const suffix of loops[0][1].trim().split(/\s+/)) {
        assert.match(suffix, new RegExp(`^${LITERAL}$`));
        inner.add(suffix);
        siblings.add(suffix);
    }
    // No other dynamic name may follow the backup path.
    assert.equal([...workflow.matchAll(/\$\{?QA_BACKUP_DIR\}?[-/]\$/g)].length, 3, 'only the loop uses a dynamic backup suffix');
    // Quoted or unquoted `$QA_BACKUP_DIR/<name>`; a sentence-ending dot is not part of the name.
    for (const match of workflow.matchAll(new RegExp(`\\$\\{?QA_BACKUP_DIR\\}?/(${LITERAL})`, 'g'))) inner.add(match[1].replace(/\.+$/, ''));
    for (const match of workflow.matchAll(new RegExp(`\\$\\{?QA_BACKUP_DIR\\}?-(${LITERAL})`, 'g'))) siblings.add(match[1]);
    for (const match of workflow.matchAll(new RegExp(`\\$\\{backup\\}-(${LITERAL})`, 'g'))) siblings.add(match[1]);
    for (const text of [workflow, helper]) {
        for (const match of text.matchAll(/path\.join\(backup, '([^']+)'/g)) inner.add(match[1].split('/')[0]);
    }
    // The only non-literal join iterates a literal list of early recovery files.
    const dynamicJoins = [...workflow.matchAll(/path\.join\(backup, (?!')/g)].length + [...helper.matchAll(/path\.join\(backup, (?!')/g)].length;
    assert.equal(dynamicJoins, 1, 'one dynamic path.join(backup, …)');
    const listed = /for \(const name of \[((?:'[^']+'(?:, )?)+)\]\) \{\n\s*const stat = fs\.lstatSync\(path\.join\(backup, name\)\);/.exec(workflow);
    assert(listed, 'the dynamic join iterates a literal list');
    for (const match of listed[1].matchAll(/'([^']+)'/g)) inner.add(match[1]);
    // The journal checkpoint writes `rollback-result.json.<16 hex>` and renames it over the journal.
    assert.match(helper, /const temporary = files\.journal \+ '\.' \+ crypto\.randomBytes\(8\)\.toString\('hex'\);/);
    inner.add(String(JOURNAL_TEMPORARY));
    return { inner, siblings };
}

const sorted = set => [...set].sort();
const whitelistInner = () => sorted(new Set([...BACKUP_INNER_ENTRIES.completion,
    ...BACKUP_INNER_ENTRIES.rollbackMarkers.map(item => typeof item === 'string' ? item : String(item))]));

test('every backup write in the deploy workflow and the rollback helper is whitelisted, and nothing else is', () => {
    const { inner, siblings } = extractBackupWrites(fs.readFileSync(WORKFLOW, 'utf8'), fs.readFileSync(ROLLBACK_HELPER, 'utf8'));
    assert.deepEqual(sorted(inner), whitelistInner());
    assert.deepEqual(sorted(siblings), [...BACKUP_SIBLING_SUFFIXES].sort());
    assert(BACKUP_INNER_ENTRIES.rollbackMarkers.some(item => item instanceof RegExp && String(item) === String(JOURNAL_TEMPORARY)));
});

test('the extraction catches the unquoted workspace sentence and the dynamic loop suffixes', () => {
    const workflow = fs.readFileSync(WORKFLOW, 'utf8');
    assert.match(workflow, /durable data restored from \$QA_BACKUP_DIR\/workspace\./);
    const { inner, siblings } = extractBackupWrites(workflow, fs.readFileSync(ROLLBACK_HELPER, 'utf8'));
    for (const suffix of ['lock-ready.json', 'lock-released.json', 'lock-release', 'lock.log', 'lock-source.txt']) {
        assert(inner.has(suffix) && siblings.has(suffix), suffix);
    }
    assert(siblings.has('helpers') && siblings.has('quiesce.log'));
    assert(!inner.has('workspace.') && !siblings.has('}') && ![...siblings].some(name => name.includes('#')));
});

test('negative controls: an unlisted write or a new dynamic suffix fails the comparison', () => {
    const workflow = fs.readFileSync(WORKFLOW, 'utf8'), helper = fs.readFileSync(ROLLBACK_HELPER, 'utf8');
    const extraInner = extractBackupWrites(workflow + '\n          printf x > "$QA_BACKUP_DIR/operator-notes.txt"\n', helper);
    assert.notDeepEqual(sorted(extraInner.inner), whitelistInner());
    const extraSibling = extractBackupWrites(workflow + '\n          printf x > "$QA_BACKUP_DIR-extra.log"\n', helper);
    assert.notDeepEqual(sorted(extraSibling.siblings), [...BACKUP_SIBLING_SUFFIXES].sort());
    const extraHelper = extractBackupWrites(workflow, helper + "\nfs.writeFileSync(path.join(backup, 'late-receipt.json'), '');\n");
    assert.notDeepEqual(sorted(extraHelper.inner), whitelistInner());
    assert.throws(() => extractBackupWrites(workflow + '\n          mv x "$QA_BACKUP_DIR/$name"\n', helper), /only the loop/);
    assert.throws(() => extractBackupWrites(workflow, helper + '\nfs.rmSync(path.join(backup, name));\n'), /one dynamic/);
    const moreSuffixes = workflow.replace('for suffix in lock-ready.json', 'for suffix in extra.json lock-ready.json');
    assert.notEqual(moreSuffixes, workflow);
    assert.notDeepEqual(sorted(extractBackupWrites(moreSuffixes, helper).inner), whitelistInner());
});
