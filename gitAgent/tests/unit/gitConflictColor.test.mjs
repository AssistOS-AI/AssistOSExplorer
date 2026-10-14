import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { categorizeStatusEntries } from '../../lib/git/status-parser.mjs';
import { toChangeRows } from '../../IDE-plugins/git-tool-button/components/git-panel/git-panel-status.js';

const css = await fs.readFile(new URL('../../IDE-plugins/git-tool-button/components/git-panel/git-panel.css', import.meta.url), 'utf8');

test('conflict red takes precedence over every other file-status color', () => {
    assert.match(css, /\.git-tree-file-row\.is-conflicted\s+\.git-tree-file\s*\{\s*color:\s*#DB5C5C;/);
    for (const status of ['modified', 'new', 'untracked', 'ignored', 'deleted']) {
        const selectors = [...css.matchAll(new RegExp(`([^{}]*\\.git-tree-file-row\\.is-${status}[^{}]*)\\{([^{}]*)\\}`, 'g'))]
            .filter(([, , declarations]) => /\bcolor\s*:/.test(declarations));
        assert.ok(selectors.length > 0, `${status} retains its normal color rule`);
        for (const [, selector] of selectors) {
            assert.ok(selector.includes(':not(.is-conflicted)'), `${status} color must not match a conflicted row`);
        }
    }
});

test('all unmerged Git statuses retain the conflict marker, including additions and deletions', () => {
    for (const xy of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
        const rows = toChangeRows(categorizeStatusEntries([{ path: 'conflict.txt', x: xy[0], y: xy[1] }]));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].kind, 'conflicted', xy);
        assert.equal(rows[0].flags.conflicted, true, xy);
    }
});
