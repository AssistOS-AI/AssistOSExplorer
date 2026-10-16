import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressLineBuffer } from '../src/lib/webchat/webchatProgressState.mjs';

function collect(events) {
    const lines = [];
    const buffer = createProgressLineBuffer((line) => lines.push(line));
    for (const event of events) buffer.push({ type: 'coding-agent-message', ...event });
    buffer.flush();
    return lines;
}

const words = (text, extra) => text.match(/\S+\s*|\n/g).map((message) => ({ message, ...extra }));

test('word deltas (OpenCode, Pi, Claude Code) are shown as whole lines', () => {
    const assistant = { outputKind: 'assistant', outputId: 'msg_1' };
    assert.deepEqual(collect([...words('I will read the shell first.\nThen I edit it.', assistant),
        { message: '', ...assistant, outputComplete: true }]), ['I will read the shell first.', 'Then I edit it.']);
});

test('a whole multi-line block (Codex) shows its last line', () => {
    assert.deepEqual(collect([{ message: 'Plan:\n\n1. Read files\n2. Edit shell\n', outputKind: 'assistant', outputComplete: true },
        { message: 'tests passed\n', outputKind: 'output' }]), ['2. Edit shell', 'tests passed']);
});

test('a partial line is shown when its stream switches or completes', () => {
    assert.deepEqual(collect([
        { message: 'Checking the', outputKind: 'assistant', outputId: 'msg_1' },
        { message: ' config', outputKind: 'assistant', outputId: 'msg_1' },
        { message: 'Write: {"file_path":"a.txt"}\n', outputKind: 'output', outputId: 'msg_1' },
        { message: 'exit code 0', outputKind: 'output' },
    ]), ['Checking the config', 'Write: {"file_path":"a.txt"}', 'exit code 0']);
});

test('a long line without a newline is split at a word boundary', () => {
    const lines = collect(words('word '.repeat(120), { outputKind: 'assistant', outputId: 'msg_1' }));
    assert.ok(lines.length >= 2);
    assert.ok(lines.every((line) => line.length <= 240 && /^(word ?)+$/.test(line)));
});
