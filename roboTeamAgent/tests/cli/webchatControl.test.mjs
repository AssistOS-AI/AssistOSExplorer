import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    handleWebchatControlChunk,
    isWebchatEscapeControlChunk
} from '../achilles-cli/src/lib/webchatControl.mjs';

describe('webchat control handling', () => {
    it('recognizes ESC control chunks from webchat', () => {
        assert.equal(isWebchatEscapeControlChunk('\x1b'), true);
        assert.equal(isWebchatEscapeControlChunk(Buffer.from('\x1b', 'utf8')), true);
        assert.equal(isWebchatEscapeControlChunk('hello\n'), false);
    });

    it('cancels the current session only while processing', () => {
        const calls = [];
        let aborted = false;
        const agent = {
            cancelCurrentSession(reason) {
                calls.push(reason);
            }
        };
        const abortController = {
            signal: { aborted: false },
            abort(reason) {
                aborted = reason;
                this.signal.aborted = true;
            }
        };

        assert.equal(handleWebchatControlChunk('\x1b', {
            agent,
            isProcessing: false,
            abortController
        }), false);
        assert.deepEqual(calls, []);
        assert.equal(aborted, false);

        assert.equal(handleWebchatControlChunk('\x1b', {
            agent,
            isProcessing: true,
            abortController
        }), true);
        assert.deepEqual(calls, ['esc']);
        assert.equal(aborted, 'esc');
    });
});
