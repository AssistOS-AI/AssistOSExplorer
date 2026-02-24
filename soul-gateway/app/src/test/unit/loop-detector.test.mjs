import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { LoopDetectedError } from '../../utils/errors.mjs';

// Silence logs during tests
process.env.LOG_LEVEL = 'critical';

const { checkLoopDetection } = await import('../../pipeline/loop-detector.mjs');

// Helper: generate a unique session ID per test to avoid cross-test interference
let sessionCounter = 0;
function freshSession() {
  return `test-session-${++sessionCounter}-${Date.now()}`;
}

function userMessage(content) {
  return [{ role: 'user', content }];
}

describe('loop-detector', () => {
  describe('rapid-fire detection', () => {
    it('allows up to 15 requests within the window', () => {
      const sid = freshSession();
      const msgs = userMessage('hello');
      for (let i = 0; i < 15; i++) {
        // Use different content each time to avoid triggering repeated content
        checkLoopDetection(sid, userMessage(`msg-${i}`), 100);
      }
    });

    it('throws on the 16th request within the window', () => {
      const sid = freshSession();
      for (let i = 0; i < 15; i++) {
        checkLoopDetection(sid, userMessage(`msg-${i}`), 100);
      }
      assert.throws(
        () => checkLoopDetection(sid, userMessage('msg-16'), 100),
        (err) => {
          assert.ok(err instanceof LoopDetectedError);
          assert.equal(err.pattern, 'rapid_fire');
          assert.equal(err.status, 429);
          assert.equal(err.retryAfter, 30);
          return true;
        },
      );
    });

    it('does not cross-contaminate between sessions', () => {
      const sid1 = freshSession();
      const sid2 = freshSession();
      for (let i = 0; i < 15; i++) {
        checkLoopDetection(sid1, userMessage(`msg-${i}`), 100);
      }
      // sid2 should still be fine
      assert.doesNotThrow(() => {
        checkLoopDetection(sid2, userMessage('hello'), 100);
      });
    });
  });

  describe('repeated content detection', () => {
    it('allows the same message up to 3 times', () => {
      const sid = freshSession();
      const msgs = userMessage('duplicate message');
      checkLoopDetection(sid, msgs, 100);
      checkLoopDetection(sid, msgs, 100);
      checkLoopDetection(sid, msgs, 100);
    });

    it('throws on the 4th identical message', () => {
      const sid = freshSession();
      const msgs = userMessage('repeated content');
      checkLoopDetection(sid, msgs, 100);
      checkLoopDetection(sid, msgs, 100);
      checkLoopDetection(sid, msgs, 100);
      assert.throws(
        () => checkLoopDetection(sid, msgs, 100),
        (err) => {
          assert.ok(err instanceof LoopDetectedError);
          assert.equal(err.pattern, 'repeated_content');
          return true;
        },
      );
    });

    it('treats different messages as distinct', () => {
      const sid = freshSession();
      checkLoopDetection(sid, userMessage('msg-a'), 100);
      checkLoopDetection(sid, userMessage('msg-a'), 100);
      checkLoopDetection(sid, userMessage('msg-a'), 100);
      // Different message should not trigger
      assert.doesNotThrow(() => {
        checkLoopDetection(sid, userMessage('msg-b'), 100);
      });
    });

    it('handles array content in user messages', () => {
      const sid = freshSession();
      const msgs = [{ role: 'user', content: [{ type: 'text', text: 'array content' }] }];
      checkLoopDetection(sid, msgs, 100);
      checkLoopDetection(sid, msgs, 100);
      checkLoopDetection(sid, msgs, 100);
      assert.throws(
        () => checkLoopDetection(sid, msgs, 100),
        (err) => {
          assert.ok(err instanceof LoopDetectedError);
          assert.equal(err.pattern, 'repeated_content');
          return true;
        },
      );
    });

    it('does not throw when no user message exists', () => {
      const sid = freshSession();
      const msgs = [{ role: 'system', content: 'sys prompt' }];
      // No user message → no content hash → no repeated content detection
      for (let i = 0; i < 5; i++) {
        assert.doesNotThrow(() => checkLoopDetection(sid, msgs, 100));
      }
    });
  });

  describe('token explosion detection', () => {
    it('allows 4 consecutive size increases without triggering', () => {
      const sid = freshSession();
      checkLoopDetection(sid, userMessage('a'), 100);
      checkLoopDetection(sid, userMessage('b'), 200);
      checkLoopDetection(sid, userMessage('c'), 300);
      checkLoopDetection(sid, userMessage('d'), 400);
    });

    it('throws on the 5th consecutive size increase', () => {
      const sid = freshSession();
      checkLoopDetection(sid, userMessage('a'), 100);
      checkLoopDetection(sid, userMessage('b'), 200);
      checkLoopDetection(sid, userMessage('c'), 300);
      checkLoopDetection(sid, userMessage('d'), 400);
      assert.throws(
        () => checkLoopDetection(sid, userMessage('e'), 500),
        (err) => {
          assert.ok(err instanceof LoopDetectedError);
          assert.equal(err.pattern, 'token_explosion');
          return true;
        },
      );
    });

    it('resets streak when size decreases', () => {
      const sid = freshSession();
      checkLoopDetection(sid, userMessage('a'), 100);
      checkLoopDetection(sid, userMessage('b'), 200);
      checkLoopDetection(sid, userMessage('c'), 300);
      checkLoopDetection(sid, userMessage('d'), 150); // breaks the streak
      checkLoopDetection(sid, userMessage('e'), 400);
      // Should not throw — streak was broken
      assert.doesNotThrow(() => {
        checkLoopDetection(sid, userMessage('f'), 500);
      });
    });

    it('does not trigger when sizes are equal', () => {
      const sid = freshSession();
      for (let i = 0; i < 10; i++) {
        // Same size every time — not strictly increasing
        assert.doesNotThrow(() => {
          checkLoopDetection(sid, userMessage(`msg-${i}`), 200);
        });
      }
    });
  });

  describe('LoopDetectedError properties', () => {
    it('has correct status, type, retryAfter, and pattern', () => {
      const err = new LoopDetectedError('rapid_fire');
      assert.equal(err.status, 429);
      assert.equal(err.type, 'loop_detected');
      assert.equal(err.retryAfter, 30);
      assert.equal(err.pattern, 'rapid_fire');
      assert.ok(err.message.includes('Loop detected'));
    });

    it('accepts custom message', () => {
      const err = new LoopDetectedError('token_explosion', 'custom msg');
      assert.equal(err.message, 'custom msg');
      assert.equal(err.pattern, 'token_explosion');
    });
  });
});
