import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { remoteUrlOrEmpty } from '../server/repository-url-projection.mjs';
import { containedWorkspaceReference, projectRobotView } from '../server/robot-projection.mjs';

// Pinned display rule shared with Ploinky's marketplace projection.
const VECTORS = [
    ['https://github.com/owner/skills.git', 'https://github.com/owner/skills.git'],
    ['  https://github.com/owner/skills  ', 'https://github.com/owner/skills'],
    ['https://user:SENTINEL@github.com/owner/skills.git', 'https://github.com/owner/skills.git'],
    ['https://SENTINELTOKEN@github.com/owner/skills.git', 'https://github.com/owner/skills.git'],
    ['https://us%65r:p%61ss@github.com/owner/skills', 'https://github.com/owner/skills'],
    ['https://github.com/owner/skills.git?access_token=SENTINEL', 'https://github.com/owner/skills.git'],
    ['https://github.com/owner/skills.git#SENTINEL', 'https://github.com/owner/skills.git'],
    ['http://git.example.test:8443/team/skills', 'http://git.example.test:8443/team/skills'],
    ['ssh://git@github.com/owner/skills.git', 'ssh://github.com/owner/skills.git'],
    ['git://github.com/owner/skills.git', 'git://github.com/owner/skills.git'],
    ['git@github.com:owner/skills.git', 'github.com:owner/skills.git'],
    ['token@localhost:owner/skills.git', ''],
    ['https://github.com/owner/%73kills', ''],
    ['https://github.com/owner/../secret', 'https://github.com/secret'],
    ['https://github.com/owner/skills\nX', ''],
    ['https://git hub.com/owner/skills', ''],
    ['https://[::1]/owner/skills', ''],
    ['ftp://github.com/owner/skills', ''],
    ['file:///sentinel-host/skills', ''],
    ['/sentinel-host/workspace/.ploinky/repos/skills', ''],
    ['./skills', ''],
    ['../skills', ''],
    ['~/skills', ''],
    ['C:\\skills', ''],
    ['', ''],
    [null, ''],
    [42, ''],
    [{ toString: () => 'https://github.com/x/y' }, ''],
];

test('repository display URLs keep only a credential-free remote origin', () => {
    for (const [input, expected] of VECTORS) assert.equal(remoteUrlOrEmpty(input), expected, JSON.stringify(input));
});

// Cross-checks the mirror against Ploinky's canonical module:
// PLOINKY_MARKETPLACE_PROJECTION_MODULE, or the sibling checkout once merged.
// Without it the comparison is skipped, never passed; acceptance and
// integration runs set ROBOTEAM_REQUIRE_URL_PARITY=1 so a missing module fails.
test('the mirrored rule matches the canonical Ploinky marketplace projection', async (t) => {
    const sibling = fileURLToPath(new URL('../../../ploinky/cli/server/authHandlers/marketplaceProjection.js', import.meta.url));
    const canonicalPath = process.env.PLOINKY_MARKETPLACE_PROJECTION_MODULE || (fs.existsSync(sibling) ? sibling : '');
    if (!canonicalPath) {
        assert.notEqual(process.env.ROBOTEAM_REQUIRE_URL_PARITY, '1', 'canonical marketplaceProjection.js is required for URL parity');
        t.skip('canonical marketplaceProjection.js not available');
        return;
    }
    const canonical = await import(pathToFileURL(canonicalPath).href);
    for (const [input] of VECTORS) assert.equal(remoteUrlOrEmpty(input), canonical.remoteUrlOrEmpty(input), JSON.stringify(input));
    process.stdout.write(`# compared ${VECTORS.length} vectors with ${canonicalPath}\n`);
});

test('task cwd becomes a contained workspace reference or is omitted', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'roboteam-cwd-reference-')));
    try {
        fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
        assert.equal(containedWorkspaceReference(root, root), '.');
        assert.equal(containedWorkspaceReference(path.join(root, 'a', 'b'), root), path.join('a', 'b'));
        assert.equal(containedWorkspaceReference(path.join(root, '..foo'), root), '..foo');
        for (const value of [path.dirname(root), `${root}-sibling`, path.join(root, '..', 'x'), 'a/b', '', null, 7]) {
            assert.equal(containedWorkspaceReference(value, root), null, String(value));
        }
        assert.equal(containedWorkspaceReference(path.join(root, 'a'), ''), null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the restricted view never mutates its input and only a strict true privilege returns it raw', () => {
    const view = { id: 'r', repositories: [{ id: 'x', source: '/sentinel/path' }], run: { state: 'stopped', task: { cwd: '/sentinel/outside', state: 'done' } } };
    const before = structuredClone(view);
    for (const privileged of [false, undefined, 'true', 1, {}]) {
        const restricted = projectRobotView(view, { privileged, workspaceRoot: '/workspace' });
        assert.equal(restricted.repositories[0].source, '');
        assert.equal('cwd' in restricted.run.task, false);
    }
    assert.deepEqual(view, before);
    assert.equal(projectRobotView(view, { privileged: true }), view);
    assert.deepEqual(projectRobotView({ ...view, run: { state: 'stopped' } }, {}).run, { state: 'stopped' });
});

test('the skills dialog labels and removes repositories by id when the display source is blank', () => {
    const dialog = fs.readFileSync(fileURLToPath(new URL('../public/skills-dialog.js', import.meta.url)), 'utf8');
    assert.match(dialog, /preferred\?\.source \|\| repo\.source \|\| repo\.id\)/);
    assert.match(dialog, /`Remove \$\{repo\.source \|\| repo\.id\}`/);
    assert.match(dialog, /mutate\('DELETE', \{ name: repo\.id \}\)/, 'removal keys on the stable repository id, never the display URL');
});
