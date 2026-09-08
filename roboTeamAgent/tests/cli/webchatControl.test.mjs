import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    handleWebchatControlChunk,
    isWebchatEscapeControlChunk
} from '../roboTeamAgent/copilot/src/lib/webchatControl.mjs';

describe('webchat control handling', () => {
    it('recognizes ESC control chunks from webchat', () => {
        assert.equal(isWebchatEscapeControlChunk('\x1b'), true);
        assert.equal(isWebchatEscapeControlChunk(Buffer.from('\x1b', 'utf8')), true);
        assert.equal(isWebchatEscapeControlChunk('hello\n'), false);
    });

    it('aborts only the owned active turn', () => {
        const abortController = new AbortController();

        assert.equal(handleWebchatControlChunk('\x1b', {
            isProcessing: false,
            abortController
        }), false);
        assert.equal(abortController.signal.aborted, false);

        assert.equal(handleWebchatControlChunk('\x1b', {
            isProcessing: true,
            abortController
        }), true);
        assert.equal(abortController.signal.aborted, true);
        assert.equal(abortController.signal.reason, 'esc');
    });
});
