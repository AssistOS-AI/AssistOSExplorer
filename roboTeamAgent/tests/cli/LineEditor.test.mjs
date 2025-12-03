import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { LineEditor, KEYS_REFERENCE } from '../src/ui/LineEditor.mjs';

describe('LineEditor', () => {
    let editor;

    beforeEach(() => {
        // Create editor with a mock stream to avoid actual output
        editor = new LineEditor({
            prompt: '> ',
            stream: { write: () => {} },
        });
    });

    describe('Basic state', () => {
        it('should initialize with empty buffer and cursor at 0', () => {
            assert.strictEqual(editor.getBuffer(), '');
            assert.strictEqual(editor.getCursorPos(), 0);
        });

        it('should set buffer and move cursor to end', () => {
            editor.setBuffer('hello');
            assert.strictEqual(editor.getBuffer(), 'hello');
            assert.strictEqual(editor.getCursorPos(), 5);
        });

        it('should clear buffer and reset cursor', () => {
            editor.setBuffer('hello');
            editor.clear();
            assert.strictEqual(editor.getBuffer(), '');
            assert.strictEqual(editor.getCursorPos(), 0);
        });
    });

    describe('Character insertion', () => {
        it('should insert characters at cursor position', () => {
            editor.insert('a');
            assert.strictEqual(editor.getBuffer(), 'a');
            assert.strictEqual(editor.getCursorPos(), 1);

            editor.insert('bc');
            assert.strictEqual(editor.getBuffer(), 'abc');
            assert.strictEqual(editor.getCursorPos(), 3);
        });

        it('should insert in middle of buffer', () => {
            editor.setBuffer('helo');
            editor.cursorPos = 2; // Position after 'he'
            editor.insert('l');
            assert.strictEqual(editor.getBuffer(), 'hello');
            assert.strictEqual(editor.getCursorPos(), 3);
        });

        it('should insert at start of buffer', () => {
            editor.setBuffer('world');
            editor.cursorPos = 0;
            editor.insert('hello ');
            assert.strictEqual(editor.getBuffer(), 'hello world');
            assert.strictEqual(editor.getCursorPos(), 6);
        });
    });

    describe('Backspace (deleteBack)', () => {
        it('should delete character before cursor', () => {
            editor.setBuffer('hello');
            const result = editor.deleteBack();
            assert.strictEqual(result, true);
            assert.strictEqual(editor.getBuffer(), 'hell');
            assert.strictEqual(editor.getCursorPos(), 4);
        });

        it('should delete character in middle of buffer', () => {
            editor.setBuffer('hello');
            editor.cursorPos = 3; // After 'hel'
            editor.deleteBack();
            assert.strictEqual(editor.getBuffer(), 'helo');
            assert.strictEqual(editor.getCursorPos(), 2);
        });

        it('should return false when cursor at start', () => {
            editor.setBuffer('hello');
            editor.cursorPos = 0;
            const result = editor.deleteBack();
            assert.strictEqual(result, false);
            assert.strictEqual(editor.getBuffer(), 'hello');
        });
    });

    describe('Delete (deleteForward)', () => {
        it('should delete character at cursor', () => {
            editor.setBuffer('hello');
            editor.cursorPos = 0;
            const result = editor.deleteForward();
            assert.strictEqual(result, true);
            assert.strictEqual(editor.getBuffer(), 'ello');
            assert.strictEqual(editor.getCursorPos(), 0);
        });

        it('should delete character in middle', () => {
            editor.setBuffer('hello');
            editor.cursorPos = 2;
            editor.deleteForward();
            assert.strictEqual(editor.getBuffer(), 'helo');
            assert.strictEqual(editor.getCursorPos(), 2);
        });

        it('should return false when cursor at end', () => {
            editor.setBuffer('hello');
            const result = editor.deleteForward();
            assert.strictEqual(result, false);
            assert.strictEqual(editor.getBuffer(), 'hello');
        });
    });

    describe('Cursor movement', () => {
        it('should move left', () => {
            editor.setBuffer('hello');
            const result = editor.moveLeft();
            assert.strictEqual(result, true);
            assert.strictEqual(editor.getCursorPos(), 4);
        });

        it('should not move left past start', () => {
            editor.setBuffer('hello');
            editor.cursorPos = 0;
            const result = editor.moveLeft();
            assert.strictEqual(result, false);
            assert.strictEqual(editor.getCursorPos(), 0);
        });

        it('should move right', () => {
            editor.setBuffer('hello');
            editor.cursorPos = 2;
            const result = editor.moveRight();
            assert.strictEqual(result, true);
            assert.strictEqual(editor.getCursorPos(), 3);
        });

        it('should not move right past end', () => {
            editor.setBuffer('hello');
            const result = editor.moveRight();
            assert.strictEqual(result, false);
            assert.strictEqual(editor.getCursorPos(), 5);
        });

        it('should move to start', () => {
            editor.setBuffer('hello');
            editor.moveToStart();
            assert.strictEqual(editor.getCursorPos(), 0);
        });

        it('should move to end', () => {
            editor.setBuffer('hello');
            editor.cursorPos = 0;
            editor.moveToEnd();
            assert.strictEqual(editor.getCursorPos(), 5);
        });
    });

    describe('Word boundary detection', () => {
        it('should find previous word boundary', () => {
            editor.setBuffer('hello world');
            editor.cursorPos = 11; // End
            assert.strictEqual(editor.findPrevWordBoundary(), 6); // Start of 'world'
        });

        it('should skip whitespace when finding prev word', () => {
            editor.setBuffer('hello   world');
            editor.cursorPos = 8; // In whitespace
            assert.strictEqual(editor.findPrevWordBoundary(), 0); // Start of 'hello'
        });

        it('should find next word boundary', () => {
            editor.setBuffer('hello world');
            editor.cursorPos = 0;
            assert.strictEqual(editor.findNextWordBoundary(), 6); // Start of 'world'
        });

        it('should handle word at end of line', () => {
            editor.setBuffer('hello');
            editor.cursorPos = 0;
            assert.strictEqual(editor.findNextWordBoundary(), 5); // End of buffer
        });

        it('should handle cursor at word boundary', () => {
            editor.setBuffer('hello world test');
            editor.cursorPos = 6; // Start of 'world'
            assert.strictEqual(editor.findPrevWordBoundary(), 0); // 'hello'
            assert.strictEqual(editor.findNextWordBoundary(), 12); // Start of 'test'
        });
    });

    describe('Word navigation', () => {
        it('should move to previous word', () => {
            editor.setBuffer('hello world');
            editor.cursorPos = 11;
            editor.moveToPrevWord();
            assert.strictEqual(editor.getCursorPos(), 6);
        });

        it('should move to next word', () => {
            editor.setBuffer('hello world');
            editor.cursorPos = 0;
            editor.moveToNextWord();
            assert.strictEqual(editor.getCursorPos(), 6);
        });

        it('should handle multiple words', () => {
            editor.setBuffer('one two three four');
            editor.cursorPos = 18; // End
            editor.moveToPrevWord();
            assert.strictEqual(editor.getCursorPos(), 14); // Start of 'four'
            editor.moveToPrevWord();
            assert.strictEqual(editor.getCursorPos(), 8); // Start of 'three'
        });
    });

    describe('Word deletion', () => {
        it('should delete word backward', () => {
            editor.setBuffer('hello world');
            const result = editor.deleteWordBack();
            assert.strictEqual(result, true);
            assert.strictEqual(editor.getBuffer(), 'hello ');
            assert.strictEqual(editor.getCursorPos(), 6);
        });

        it('should delete word forward', () => {
            editor.setBuffer('hello world');
            editor.cursorPos = 0;
            const result = editor.deleteWordForward();
            assert.strictEqual(result, true);
            assert.strictEqual(editor.getBuffer(), 'world');
            assert.strictEqual(editor.getCursorPos(), 0);
        });

        it('should return false when no word to delete backward', () => {
            editor.setBuffer('hello');
            editor.cursorPos = 0;
            const result = editor.deleteWordBack();
            assert.strictEqual(result, false);
        });

        it('should return false when no word to delete forward', () => {
            editor.setBuffer('hello');
            const result = editor.deleteWordForward();
            assert.strictEqual(result, false);
        });

        it('should delete word in middle of buffer', () => {
            editor.setBuffer('one two three');
            editor.cursorPos = 7; // After 'two', before space
            editor.deleteWordBack();
            // Deletes 'two' (positions 4-6), preserving spaces at 3 and 7
            assert.strictEqual(editor.getBuffer(), 'one  three');
            assert.strictEqual(editor.getCursorPos(), 4);
        });
    });

    describe('Line operations', () => {
        it('should clear entire line', () => {
            editor.setBuffer('hello world');
            editor.cursorPos = 5;
            editor.clearLine();
            assert.strictEqual(editor.getBuffer(), '');
            assert.strictEqual(editor.getCursorPos(), 0);
        });

        it('should kill to end of line', () => {
            editor.setBuffer('hello world');
            editor.cursorPos = 5;
            const result = editor.killToEnd();
            assert.strictEqual(result, true);
            assert.strictEqual(editor.getBuffer(), 'hello');
            assert.strictEqual(editor.getCursorPos(), 5);
        });

        it('should return false when killing at end of line', () => {
            editor.setBuffer('hello');
            const result = editor.killToEnd();
            assert.strictEqual(result, false);
            assert.strictEqual(editor.getBuffer(), 'hello');
        });
    });

    describe('Key processing', () => {
        it('should process left arrow', () => {
            editor.setBuffer('hello');
            const result = editor.processKey('\x1b[D');
            assert.strictEqual(result, 'cursor');
            assert.strictEqual(editor.getCursorPos(), 4);
        });

        it('should process right arrow', () => {
            editor.setBuffer('hello');
            editor.cursorPos = 2;
            const result = editor.processKey('\x1b[C');
            assert.strictEqual(result, 'cursor');
            assert.strictEqual(editor.getCursorPos(), 3);
        });

        it('should process Ctrl+A', () => {
            editor.setBuffer('hello');
            const result = editor.processKey('\x01');
            assert.strictEqual(result, 'cursor');
            assert.strictEqual(editor.getCursorPos(), 0);
        });

        it('should process Ctrl+E', () => {
            editor.setBuffer('hello');
            editor.cursorPos = 0;
            const result = editor.processKey('\x05');
            assert.strictEqual(result, 'cursor');
            assert.strictEqual(editor.getCursorPos(), 5);
        });

        it('should process Ctrl+U', () => {
            editor.setBuffer('hello');
            const result = editor.processKey('\x15');
            assert.strictEqual(result, 'modified');
            assert.strictEqual(editor.getBuffer(), '');
        });

        it('should process Ctrl+K', () => {
            editor.setBuffer('hello world');
            editor.cursorPos = 5;
            const result = editor.processKey('\x0b');
            assert.strictEqual(result, 'modified');
            assert.strictEqual(editor.getBuffer(), 'hello');
        });

        it('should process Ctrl+Backspace', () => {
            editor.setBuffer('hello world');
            const result = editor.processKey('\x17');  // Ctrl+W variant
            assert.strictEqual(result, 'modified');
            assert.strictEqual(editor.getBuffer(), 'hello ');
        });

        it('should process backspace', () => {
            editor.setBuffer('hello');
            const result = editor.processKey('\x7f');
            assert.strictEqual(result, 'modified');
            assert.strictEqual(editor.getBuffer(), 'hell');
        });

        it('should process delete key', () => {
            editor.setBuffer('hello');
            editor.cursorPos = 0;
            const result = editor.processKey('\x1b[3~');
            assert.strictEqual(result, 'modified');
            assert.strictEqual(editor.getBuffer(), 'ello');
        });

        it('should process regular characters', () => {
            const result = editor.processKey('a');
            assert.strictEqual(result, 'modified');
            assert.strictEqual(editor.getBuffer(), 'a');
        });

        it('should return unhandled for unknown keys', () => {
            const result = editor.processKey('\x1b[99~');
            assert.strictEqual(result, 'unhandled');
        });

        it('should return none when backspace at start', () => {
            editor.setBuffer('hello');
            editor.cursorPos = 0;
            const result = editor.processKey('\x7f');
            assert.strictEqual(result, 'none');
            assert.strictEqual(editor.getBuffer(), 'hello');
        });

        it('should process Ctrl+Left', () => {
            editor.setBuffer('hello world');
            const result = editor.processKey('\x1b[1;5D');
            assert.strictEqual(result, 'cursor');
            assert.strictEqual(editor.getCursorPos(), 6);
        });

        it('should process Alt+Left', () => {
            editor.setBuffer('hello world');
            const result = editor.processKey('\x1b[1;3D');
            assert.strictEqual(result, 'cursor');
            assert.strictEqual(editor.getCursorPos(), 6);
        });

        it('should process Ctrl+Right', () => {
            editor.setBuffer('hello world');
            editor.cursorPos = 0;
            const result = editor.processKey('\x1b[1;5C');
            assert.strictEqual(result, 'cursor');
            assert.strictEqual(editor.getCursorPos(), 6);
        });

        it('should process Alt+Right', () => {
            editor.setBuffer('hello world');
            editor.cursorPos = 0;
            const result = editor.processKey('\x1b[1;3C');
            assert.strictEqual(result, 'cursor');
            assert.strictEqual(editor.getCursorPos(), 6);
        });

        it('should process Home key variants', () => {
            editor.setBuffer('hello');

            // Test first variant
            let result = editor.processKey('\x1b[H');
            assert.strictEqual(result, 'cursor');
            assert.strictEqual(editor.getCursorPos(), 0);

            // Reset and test second variant
            editor.cursorPos = 5;
            result = editor.processKey('\x1b[1~');
            assert.strictEqual(result, 'cursor');
            assert.strictEqual(editor.getCursorPos(), 0);
        });

        it('should process End key variants', () => {
            editor.setBuffer('hello');
            editor.cursorPos = 0;

            // Test first variant
            let result = editor.processKey('\x1b[F');
            assert.strictEqual(result, 'cursor');
            assert.strictEqual(editor.getCursorPos(), 5);

            // Reset and test second variant
            editor.cursorPos = 0;
            result = editor.processKey('\x1b[4~');
            assert.strictEqual(result, 'cursor');
            assert.strictEqual(editor.getCursorPos(), 5);
        });
    });

    describe('Edge cases', () => {
        it('should handle empty buffer operations', () => {
            assert.strictEqual(editor.deleteBack(), false);
            assert.strictEqual(editor.deleteForward(), false);
            assert.strictEqual(editor.moveLeft(), false);
            assert.strictEqual(editor.moveRight(), false);
            assert.strictEqual(editor.deleteWordBack(), false);
            assert.strictEqual(editor.deleteWordForward(), false);
            assert.strictEqual(editor.killToEnd(), false);
        });

        it('should handle single character buffer', () => {
            editor.setBuffer('a');
            editor.deleteBack();
            assert.strictEqual(editor.getBuffer(), '');
            assert.strictEqual(editor.getCursorPos(), 0);
        });

        it('should handle buffer with only spaces', () => {
            editor.setBuffer('   ');
            editor.deleteWordBack();
            assert.strictEqual(editor.getBuffer(), '');
        });

        it('should handle consecutive word operations', () => {
            editor.setBuffer('one two three');
            editor.deleteWordBack();
            assert.strictEqual(editor.getBuffer(), 'one two ');
            editor.deleteWordBack();
            assert.strictEqual(editor.getBuffer(), 'one ');
            editor.deleteWordBack();
            assert.strictEqual(editor.getBuffer(), '');
        });
    });
});
