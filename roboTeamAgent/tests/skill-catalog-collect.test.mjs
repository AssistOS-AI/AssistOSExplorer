import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LiveSkillCatalog } from '../server/live-skill-catalog.mjs';
import { registerProject } from '../server/project-storage.mjs';
import { readRegularFile } from '../server/skill-files.mjs';

const hex = letter => letter.repeat(64);

test('catalog collection skips a conversation record a robot planted instead of waiting on it or ending the pass', async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-collect-')));
    const options = { dataDir: path.join(root, '.data/roboTeamAgent'), workspaceRoot: root };
    const robotRoot = path.join(options.dataDir, 'robots', 'worker-123456');
    const catalogs = path.join(robotRoot, 'runtime', 'skill-catalogs');
    const fifos = [];
    t.after(() => {
        // Release a read that is still waiting for a writer, so the test process can end.
        for (const fifo of fifos) { try { fs.closeSync(fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK)); } catch { /* not waiting */ } }
        fs.rmSync(root, { recursive: true, force: true });
    });
    const record = (project, id) => { const directory = path.join(project, '.roboteam/sessions', id); fs.mkdirSync(directory, { recursive: true }); return path.join(directory, 'config.json'); };
    const planted = path.join(root, 'planted'), garbled = path.join(root, 'garbled'), kept = path.join(root, 'kept');
    for (const project of [planted, garbled, kept]) { fs.mkdirSync(project); registerProject(options, project); }
    const fifo = record(planted, '11111111-1111-4111-8111-111111111111');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    fifos.push(fifo);
    fs.writeFileSync(record(garbled, '22222222-2222-4222-8222-222222222222'), '{ not json');
    fs.writeFileSync(record(kept, '33333333-3333-4333-8333-333333333333'), JSON.stringify({ skillExecution: { catalogId: hex('a') } }));
    // Five old catalogs: the two newest are kept by count, `a` is still used by a conversation, `b` is nobody's.
    ['e', 'd', 'c', 'a', 'b'].forEach((letter, index) => {
        const directory = path.join(catalogs, hex(letter));
        fs.mkdirSync(directory, { recursive: true });
        const old = new Date(Date.now() - (index + 1) * 3600000 * 24);
        fs.utimesSync(directory, old, old);
    });
    const service = { workspaceRoot: root, robotStore: { dataDir: options.dataDir, robotPath: () => robotRoot, withRobot: async (_id, work) => work() },
        policies: { directory: () => path.join(robotRoot, 'policies'), read: async () => null } };
    const catalog = new LiveSkillCatalog(service);
    const finished = await Promise.race([catalog.collect('worker-123456', { maxAgeMs: 0, keep: 2 }).then(() => true), new Promise(resolve => setTimeout(resolve, 3000, false))]);
    assert.equal(finished, true, 'collection waited on a planted FIFO');
    assert.deepEqual(fs.readdirSync(catalogs).filter(name => /^[a-f0-9]{64}$/.test(name)).sort(), [hex('a'), hex('d'), hex('e')]);
});

test('a record read refuses a FIFO and a link without waiting for a writer', async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'record-read-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'record.json'), fifo = path.join(root, 'fifo.json'), link = path.join(root, 'link.json');
    fs.writeFileSync(file, '{"ok":true}');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    fs.symlinkSync(file, link);
    assert.equal(await readRegularFile(file), '{"ok":true}');
    await assert.rejects(readRegularFile(fifo), /not a regular file/u);
    await assert.rejects(readRegularFile(link));
});
