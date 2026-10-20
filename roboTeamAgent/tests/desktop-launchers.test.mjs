import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CHROMIUM_LAUNCHER, prepareDesktopLaunchers } from '../server/desktop-launchers.mjs';

test('the robot desktop receives an executable Chromium launcher', async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-desktop-launchers-'));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const launcher = path.join(home, 'Desktop', 'chromium.desktop');
    await prepareDesktopLaunchers(home);
    assert.equal(await fs.readFile(launcher, 'utf8'), CHROMIUM_LAUNCHER);
    assert.equal((await fs.stat(launcher)).mode & 0o777, 0o755);
    assert.match(CHROMIUM_LAUNCHER, /^Exec=\/usr\/local\/bin\/roboteam-open-browser$/m);

    await fs.writeFile(launcher, '[Desktop Entry]\nExec=/bin/false\n');
    await fs.chmod(launcher, 0o644);
    await prepareDesktopLaunchers(home);
    assert.equal(await fs.readFile(launcher, 'utf8'), CHROMIUM_LAUNCHER);
    assert.equal((await fs.stat(launcher)).mode & 0o777, 0o755);
    assert.deepEqual(await fs.readdir(path.join(home, 'Desktop')), ['chromium.desktop']);
});

test('a symlinked desktop folder is refused', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-desktop-launchers-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    await fs.mkdir(home);
    await fs.mkdir(path.join(root, 'elsewhere'));
    await fs.symlink(path.join(root, 'elsewhere'), path.join(home, 'Desktop'));
    await assert.rejects(prepareDesktopLaunchers(home), /Unsafe robot desktop directory/);
    assert.deepEqual(await fs.readdir(path.join(root, 'elsewhere')), []);
});
