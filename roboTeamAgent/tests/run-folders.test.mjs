import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ScheduleFolders } from '../server/roboflow/schedule-folders.mjs';
import { RunFolders, jobFolderName } from '../server/roboflow/run-folders.mjs';

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-run-folders-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const folders = new ScheduleFolders(root);
    const runs = new RunFolders({ folders, now: () => Date.parse('2026-10-12T14:28:05.123Z'), resolveCwd: async folder => {
        const canonical = await fs.realpath(folder);
        if (canonical !== root && !canonical.startsWith(root + path.sep)) throw new Error('Outside workspace');
        return canonical;
    } });
    return { root, folders, runs };
}
test('a run without a folder gets a timestamped folder under workflow-runs', async t => {
    const { root, runs } = await fixture(t);
    const direct = await runs.create();
    assert.equal(direct, path.join(root, 'workflow-runs', 'run-2026-10-12_14-28-05-123Z'));
    assert.ok((await fs.stat(direct)).isDirectory());
});
test('concurrent launches in the same millisecond never reuse a run folder', async t => {
    const { runs } = await fixture(t);
    const destinations = await Promise.all(Array.from({ length: 12 }, () => runs.create('')));
    assert.equal(new Set(destinations).size, destinations.length);
    for (const destination of destinations) assert.match(path.basename(destination), /^run-2026-10-12_14-28-05-123Z(?:-[a-f0-9]{8})?$/);
});
test('each Cron job reuses one folder named after its workflow and job, below the selected parent', async t => {
    const { root, runs } = await fixture(t);
    const reports = path.join(root, 'Reports'); await fs.mkdir(reports);
    await fs.writeFile(path.join(reports, 'existing.md'), 'Keep this report');
    assert.equal(jobFolderName('daily-report', 'cron_3f2a9c1b0d4e5f6a7b8c9d0e'), 'daily-report-3f2a9c1b');
    const first = await runs.forJob(reports, 'daily-report', 'cron_3f2a9c1b0d4e5f6a7b8c9d0e');
    assert.equal(first, path.join(reports, 'daily-report-3f2a9c1b'));
    await fs.writeFile(path.join(first, 'notes.md'), 'Left by the first run');
    assert.equal(await runs.forJob(reports, 'daily-report', 'cron_3f2a9c1b0d4e5f6a7b8c9d0e'), first);
    assert.equal(await fs.readFile(path.join(first, 'notes.md'), 'utf8'), 'Left by the first run');
    assert.notEqual(await runs.forJob(reports, 'daily-report', 'cron_99999999aaaaaaaabbbbbbbb'), first);
    assert.equal(await fs.readFile(path.join(reports, 'existing.md'), 'utf8'), 'Keep this report');
    await assert.rejects(runs.forJob(os.tmpdir(), 'daily-report', 'cron_3f2a9c1b'), /Outside workspace/);
    await fs.symlink(reports, path.join(reports, 'linked-12345678'));
    await assert.rejects(runs.forJob(reports, 'linked', 'cron_12345678'), { statusCode: 400 });
});
test('legacy default resolves to workflow-runs without moving files or requiring the old folder', async t => {
    const { root, runs } = await fixture(t), legacy = path.join(root, 'cron-jobs-results');
    assert.equal(await runs.base(legacy), path.join(root, 'workflow-runs'));
    await fs.mkdir(legacy); await fs.writeFile(path.join(legacy, 'old.md'), 'Old report');
    const destination = await runs.forJob(legacy, 'report', 'cron_abcdef12');
    assert.equal(path.dirname(destination), path.join(root, 'workflow-runs'));
    assert.equal(await fs.readFile(path.join(legacy, 'old.md'), 'utf8'), 'Old report');
});
test('an explicitly presented default parent can be selected before the first run creates it', async t => {
    const { root, runs } = await fixture(t);
    const selected = path.join(root, 'workflow-runs');
    assert.equal(await runs.base(selected), selected);
    assert.ok((await fs.stat(selected)).isDirectory());
});
test('a default-folder symlink is rejected without writing run directories through it', async t => {
    const { root, runs } = await fixture(t);
    const reports = path.join(root, 'Reports'); await fs.mkdir(reports);
    await fs.symlink(reports, path.join(root, 'workflow-runs'));
    await assert.rejects(runs.create(), { statusCode: 400 });
    assert.deepEqual(await fs.readdir(reports), []);
});
test('rejected launches discard only an empty newly allocated folder', async t => {
    const { runs } = await fixture(t), empty = await runs.create();
    await runs.discard(empty); await assert.rejects(fs.stat(empty), { code: 'ENOENT' });
    const populated = await runs.create(); await fs.writeFile(path.join(populated, 'result.md'), 'Keep');
    await runs.discard(populated);
    assert.equal(await fs.readFile(path.join(populated, 'result.md'), 'utf8'), 'Keep');
});
