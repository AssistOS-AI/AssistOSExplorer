// Linux-only tests of the 'linux-procfd' grant resolver on a real Linux file system (S5 Linux fix delta L-3; diagnosis
// addendum section C).
//
// This file is deliberately NOT named *.test.mjs, so the Mac set ('robo-work/tests/**/*.test.mjs') never selects it. A
// Linux run selects it through an explicit runner list entry. Every test first asserts that it runs on Linux with the
// 'linux-procfd' default strategy and FAILS otherwise: nothing here skips. The exact number of tests is recorded in
// grantResolver.linux-procfd.expected.json; the Linux acceptance checks `# tests` equal to it, `# pass` equal to
// `# tests`, and zero fail, skip, cancelled and todo (review note M4). The Mac-side test 'the Linux-only test file declares
// its exact test count' keeps the two in step.
//
// Scope: host file system (for example /tmp) under the Node that runs the file. The Box file system (overlay or
// virtiofs) and the qualifying Node are G4/G6 work.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { STRATEGIES, defaultStrategy, resolveGrant } from '../../server/views/grantResolver.mjs';

function assertLinux() {
    assert.equal(process.platform, 'linux', 'grantResolver.linux-procfd.mjs runs only on Linux; it fails, never skips, elsewhere');
    assert.equal(defaultStrategy(), STRATEGIES.LINUX);
}

// A real temporary workspace. The cleanup also covers a renamed workspace root.
function workspace(context) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rwl-'));
    context.after(() => {
        for (const candidate of [root, `${root}.moved`]) fs.rmSync(candidate, { recursive: true, force: true });
    });
    for (const directory of ['proj', 'proj/sub', 'a/b', 'outside-target', '.data/store', '.ploinky/repos']) {
        fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    return root;
}

const openFdCount = () => fs.readdirSync('/proc/self/fd').length;
const project = (relativePath) => ({ relativePath, access: 'write', role: 'project' });
const resolve = (root, relativePath, extra = {}, hooks = {}) => resolveGrant(project(relativePath), { workspaceRoot: root, ...extra }, hooks);
const mv = (root, from, to) => fs.renameSync(path.join(root, from), path.join(root, to));

async function grantFor(root, relativePath, extra = {}) {
    const result = await resolve(root, relativePath, extra);
    assert.equal(result.ok, true, `${relativePath}: ${JSON.stringify(result)}`);
    return result.grant;
}

test('platform guard: this is Linux, the default strategy is linux-procfd, and a real grant records it', async (t) => {
    assertLinux();
    const root = workspace(t);
    const grant = await grantFor(root, 'proj/sub');
    assert.equal(grant.strategy, STRATEGIES.LINUX);
    assert.deepEqual(await grant.verifyBinding(), { state: 'bound' });
    await grant.close();
});

test('L-2: a symlink as the grant, in the middle, or aliasing controller state is refused as symlink_in_path with no descriptor left', async (t) => {
    assertLinux();
    const root = workspace(t);
    fs.symlinkSync('proj', path.join(root, 'link-to-proj'));
    fs.symlinkSync(path.join(root, 'outside-target'), path.join(root, 'link-outside'));
    fs.symlinkSync('.data', path.join(root, 'alias'));
    fs.symlinkSync('../..', path.join(root, 'proj/up'));
    fs.symlinkSync('a', path.join(root, 'mid'));
    for (const relativePath of ['link-to-proj', 'link-outside', 'alias', 'alias/store', 'proj/up', 'mid/b', 'link-to-proj/sub']) {
        const before = openFdCount();
        const result = await resolve(root, relativePath);
        assert.equal(result.ok, false, relativePath);
        assert.equal(result.code, 'symlink_in_path', relativePath);
        assert.equal(openFdCount(), before, `${relativePath}: no descriptor survives the refusal`);
    }
    fs.writeFileSync(path.join(root, 'proj/file.txt'), 'x');
    assert.equal((await resolve(root, 'proj/file.txt')).code, 'not_a_directory', 'control: a plain file is not a directory');
});

test('L-1 case A: an already-verified ancestor renamed in the middle of verification is root_unbound at index 1', async (t) => {
    assertLinux();
    const root = workspace(t);
    const grant = await grantFor(root, 'a/b');
    const result = await grant.verifyBinding({ beforeComponent: (index) => { if (index === 1) mv(root, 'a', 'a.moved'); } });
    assert.deepEqual(result, { state: 'unbound', code: 'root_unbound', index: 1 });
    await grant.close();
});

test('L-1 case B: an already-verified ancestor moved into .data in the middle of verification is root_unbound at index 1', async (t) => {
    assertLinux();
    const root = workspace(t);
    const grant = await grantFor(root, 'a/b');
    const result = await grant.verifyBinding({ beforeComponent: (index) => { if (index === 1) mv(root, 'a', '.data/a'); } });
    assert.deepEqual(result, { state: 'unbound', code: 'root_unbound', index: 1 });
    await grant.close();
});

test('L-1 case C: the component about to be checked, renamed in the middle of verification, is root_unbound at index 1', async (t) => {
    assertLinux();
    const root = workspace(t);
    const grant = await grantFor(root, 'a/b');
    const result = await grant.verifyBinding({ beforeComponent: (index) => { if (index === 1) mv(root, 'a/b', 'a/b2'); } });
    assert.deepEqual(result, { state: 'unbound', code: 'root_unbound', index: 1 });
    await grant.close();
});

test('L-1 case D: an ancestor renamed before its own check is ancestor_unbound at index 0', async (t) => {
    assertLinux();
    const root = workspace(t);
    const grant = await grantFor(root, 'a/b');
    const result = await grant.verifyBinding({ beforeComponent: (index) => { if (index === 0) mv(root, 'a', 'a.moved'); } });
    assert.deepEqual(result, { state: 'unbound', code: 'ancestor_unbound', index: 0 });
    await grant.close();
});

test('L-1 residual (M1): an ancestor renamed in the pass and replaced by a symlink to its new place is bound in that pass and refused at the next', async (t) => {
    assertLinux();
    const root = workspace(t);
    const grant = await grantFor(root, 'a/b');
    const inPass = await grant.verifyBinding({
        beforeComponent: (index) => {
            if (index !== 1) return;
            mv(root, 'a', '.data/a');
            fs.symlinkSync('.data/a', path.join(root, 'a'));
        }
    });
    assert.deepEqual(inPass, { state: 'bound' }, 'documented residual: a path lstat follows the middle link');
    assert.deepEqual(await grant.verifyBinding(), { state: 'unbound', code: 'symlink_in_path', index: 0 }, 'caught at the next renewal');
    await grant.close();
});

test('L-1 case E: a rename of the workspace root after admission is ancestor_unbound at index 0', async (t) => {
    assertLinux();
    const root = workspace(t);
    const grant = await grantFor(root, 'a/b');
    assert.deepEqual(await grant.verifyBinding(), { state: 'bound' });
    fs.renameSync(root, `${root}.moved`);
    assert.deepEqual(await grant.verifyBinding(), { state: 'unbound', code: 'ancestor_unbound', index: 0 });
    await grant.close();
});

test('L-1 admission (M2): an ancestor renamed between two bracket steps is a substitution, with no descriptor left', async (t) => {
    assertLinux();
    const root = workspace(t);
    const before = openFdCount();
    const result = await resolve(root, 'a/b', {}, { beforeBracketComponent: (index) => { if (index === 1) mv(root, 'a', 'a.moved'); } });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'substitution_detected');
    assert.equal(openFdCount(), before);
});

test('L-1 call shape: per component the edge lstat, then the anchored path lstat; no open, and no descriptor growth', async (t) => {
    assertLinux();
    const root = workspace(t);
    const targets = [];
    const fsApi = {
        open: (target, flags) => fs.promises.open(target, flags),
        lstat: (target, options) => { targets.push(target); return fs.promises.lstat(target, options); },
        realpath: (target) => fs.promises.realpath(target)
    };
    const grant = await grantFor(root, 'a/b', { fsApi });
    targets.length = 0;
    const held = openFdCount();
    assert.deepEqual(await grant.verifyBinding(), { state: 'bound' });
    assert.equal(openFdCount(), held);
    assert.equal(targets.length, 4);
    assert.match(targets[0], /^\/proc\/self\/fd\/\d+\/a$/);
    assert.equal(targets[1], path.join(root, 'a'));
    assert.match(targets[2], /^\/proc\/self\/fd\/\d+\/b$/);
    assert.equal(targets[3], path.join(root, 'a/b'));
    await grant.close();
});
