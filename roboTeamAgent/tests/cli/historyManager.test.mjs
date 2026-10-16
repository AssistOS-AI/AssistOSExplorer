import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryManager } from '../roboTeamAgent/copilot/src/repl/HistoryManager.mjs';

function workspace(t) {
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-history-'));
    t.after(() => fs.rmSync(workingDir, { recursive: true, force: true }));
    return workingDir;
}

test('history preserves multiline input, consecutive deduplication, navigation and limits after reopening', async (t) => {
    const workingDir = workspace(t);
    const manager = new HistoryManager({ workingDir, maxEntries: 3 });
    await manager.add('old');
    await manager.add('  first  ');
    await manager.add('line one\nline two');
    await manager.add('line one\nline two');
    await manager.add('last');
    const reopened = new HistoryManager({ workingDir, maxEntries: 3 });
    assert.deepEqual(reopened.getAll(), ['first', 'line one\nline two', 'last']);
    assert.equal(reopened.getPrevious(), 'last');
    assert.equal(reopened.getPrevious(), 'line one\nline two');
    assert.equal(reopened.getNext(), 'last');
    assert.equal(reopened.getNext(), null);
    assert.deepEqual(reopened.search('LINE'), [{ index: 2, command: 'line one\nline two' }]);
    await reopened.add('first');
    assert.deepEqual(reopened.getAll(), ['line one\nline two', 'last', 'first']);
});

test('legacy lines migrate without a stale manager save erasing a newer append or resurrecting cleared entries', async (t) => {
    const workingDir = workspace(t);
    const first = new HistoryManager({ workingDir });
    fs.mkdirSync(path.dirname(first.getHistoryPath()), { recursive: true });
    fs.writeFileSync(first.getHistoryPath(), 'legacy command\n{literal object}\n');
    const stale = new HistoryManager({ workingDir });
    await first.add('new\ncommand');
    await stale.save();
    assert.deepEqual(new HistoryManager({ workingDir }).getAll(), ['legacy command', '{literal object}', 'new\ncommand']);
    await first.clear();
    await stale.save();
    assert.deepEqual(new HistoryManager({ workingDir }).getAll(), []);
    await stale.add('after clear');
    assert.deepEqual(new HistoryManager({ workingDir }).getAll(), ['after clear']);
});

test('history refuses a substituted symlink without modifying its target', async (t) => {
    const workingDir = workspace(t);
    const outside = path.join(workspace(t), 'history');
    fs.writeFileSync(outside, 'outside\n');
    const manager = new HistoryManager({ workingDir });
    await manager.add('inside');
    fs.unlinkSync(manager.getHistoryPath());
    fs.symlinkSync(outside, manager.getHistoryPath());
    assert.throws(() => new HistoryManager({ workingDir }), /symbolic link/);
    await assert.rejects(manager.add('blocked'), /symbolic link/);
    await assert.rejects(manager.clear(), /symbolic link/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n');
});
