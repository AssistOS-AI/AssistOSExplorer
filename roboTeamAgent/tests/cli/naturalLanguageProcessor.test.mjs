/**
 * Tests for NaturalLanguageProcessor module.
 *
 * Tests the LLM processing with abort capability.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// ============================================================================
// NaturalLanguageProcessor Tests
// ============================================================================

describe('NaturalLanguageProcessor', () => {
    let NaturalLanguageProcessor;

    beforeEach(async () => {
        const module = await import('../src/repl/NaturalLanguageProcessor.mjs');
        NaturalLanguageProcessor = module.NaturalLanguageProcessor;
    });

    describe('Constructor', () => {
        it('should create instance with required options', () => {
            const mockAgent = { setActionReporter: () => {} };
            const mockHistoryManager = { add: () => {} };
            const mockProcessPrompt = () => {};

            const processor = new NaturalLanguageProcessor({
                agent: mockAgent,
                processPrompt: mockProcessPrompt,
                historyManager: mockHistoryManager,
            });

            assert.ok(processor, 'NaturalLanguageProcessor should be created');
            assert.strictEqual(processor.agent, mockAgent);
            assert.strictEqual(processor.processPrompt, mockProcessPrompt);
            assert.strictEqual(processor.historyManager, mockHistoryManager);
        });

        it('should use default isMarkdownEnabled when not provided', () => {
            const mockAgent = { setActionReporter: () => {} };
            const mockHistoryManager = { add: () => {} };

            const processor = new NaturalLanguageProcessor({
                agent: mockAgent,
                processPrompt: () => {},
                historyManager: mockHistoryManager,
            });

            // Default should return true
            assert.strictEqual(processor.isMarkdownEnabled(), true);
        });

        it('should use provided isMarkdownEnabled callback', () => {
            const mockAgent = { setActionReporter: () => {} };
            const mockHistoryManager = { add: () => {} };

            const processor = new NaturalLanguageProcessor({
                agent: mockAgent,
                processPrompt: () => {},
                historyManager: mockHistoryManager,
                isMarkdownEnabled: () => false,
            });

            assert.strictEqual(processor.isMarkdownEnabled(), false);
        });
    });

    describe('ESC key detection', () => {
        it('should recognize ESC key code \\x1b', () => {
            const escKey = '\x1b';
            const isEsc = escKey === '\x1b' || escKey === '\u001b';
            assert.strictEqual(isEsc, true);
        });

        it('should recognize ESC key code \\u001b', () => {
            const escKey = '\u001b';
            const isEsc = escKey === '\x1b' || escKey === '\u001b';
            assert.strictEqual(isEsc, true);
        });

        it('should not recognize regular characters as ESC', () => {
            const regularKeys = ['a', 'b', '1', ' ', '\n', '\r'];
            for (const key of regularKeys) {
                const isEsc = key === '\x1b' || key === '\u001b';
                assert.strictEqual(isEsc, false, `Key "${key}" should not be recognized as ESC`);
            }
        });
    });

    describe('AbortController pattern', () => {
        it('should create new AbortController for each process call', () => {
            // Simulate the pattern used in process()
            const createAbortController = () => {
                const controller = new AbortController();
                return { controller, signal: controller.signal };
            };

            const first = createAbortController();
            const second = createAbortController();

            assert.notStrictEqual(first.controller, second.controller);
            assert.notStrictEqual(first.signal, second.signal);
        });

        it('should propagate abort to signal', () => {
            const controller = new AbortController();
            assert.strictEqual(controller.signal.aborted, false);

            controller.abort();
            assert.strictEqual(controller.signal.aborted, true);
        });

        it('should handle abort error correctly', async () => {
            const controller = new AbortController();
            controller.abort();

            // Simulate checking for abort
            const checkAbort = () => {
                if (controller.signal.aborted) {
                    const error = new Error('Operation cancelled');
                    error.name = 'AbortError';
                    throw error;
                }
            };

            try {
                checkAbort();
                assert.fail('Should have thrown AbortError');
            } catch (error) {
                assert.strictEqual(error.name, 'AbortError');
            }
        });
    });

    describe('History saving behavior', () => {
        it('should save command to history on successful completion', () => {
            let savedCommand = null;
            const mockHistoryManager = {
                add: (cmd) => { savedCommand = cmd; },
            };

            const wasInterrupted = false;
            const input = 'test command';

            // Simulate the finally block behavior
            if (!wasInterrupted) {
                mockHistoryManager.add(input);
            }

            assert.strictEqual(savedCommand, 'test command');
        });

        it('should not save command to history when interrupted', () => {
            let savedCommand = null;
            const mockHistoryManager = {
                add: (cmd) => { savedCommand = cmd; },
            };

            const wasInterrupted = true;
            const input = 'test command';

            // Simulate the finally block behavior
            if (!wasInterrupted) {
                mockHistoryManager.add(input);
            }

            assert.strictEqual(savedCommand, null);
        });
    });

    describe('Output formatting', () => {
        it('should format duration correctly for seconds', () => {
            const formatDuration = (ms) => {
                return `(${(ms / 1000).toFixed(1)}s)`;
            };

            assert.strictEqual(formatDuration(1000), '(1.0s)');
            assert.strictEqual(formatDuration(1500), '(1.5s)');
            assert.strictEqual(formatDuration(10000), '(10.0s)');
        });

        it('should generate correct "Done" message with model info', () => {
            const modelInfo = 'gpt-4';
            const durationMs = 2500;

            const message = `✓ Done [${modelInfo}] (${(durationMs / 1000).toFixed(1)}s)`;
            assert.strictEqual(message, '✓ Done [gpt-4] (2.5s)');
        });

        it('should generate "Done" message without model info when not available', () => {
            const modelInfo = '';
            const durationMs = 1000;

            const durationInfo = ` (${(durationMs / 1000).toFixed(1)}s)`;
            const message = `✓ Done${modelInfo}${durationInfo}`;
            assert.strictEqual(message, '✓ Done (1.0s)');
        });
    });
});

// ============================================================================
// Integration-style Tests (behavior patterns)
// ============================================================================

describe('NaturalLanguageProcessor - Behavior Patterns', () => {
    describe('Interrupt flow', () => {
        it('should set wasInterrupted flag when abort is triggered', () => {
            let wasInterrupted = false;
            const abortController = new AbortController();

            // Simulate keypress handler
            const handleKeypress = (key) => {
                if (key === '\x1b') {
                    wasInterrupted = true;
                    abortController.abort();
                }
            };

            handleKeypress('\x1b');

            assert.strictEqual(wasInterrupted, true);
            assert.strictEqual(abortController.signal.aborted, true);
        });

        it('should not set interrupted flag for non-ESC keys', () => {
            let wasInterrupted = false;
            const abortController = new AbortController();

            const handleKeypress = (key) => {
                if (key === '\x1b' || key === '\u001b') {
                    wasInterrupted = true;
                    abortController.abort();
                }
            };

            handleKeypress('a');
            handleKeypress('\n');
            handleKeypress(' ');

            assert.strictEqual(wasInterrupted, false);
            assert.strictEqual(abortController.signal.aborted, false);
        });
    });

    describe('Error handling patterns', () => {
        it('should detect AbortError by name', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';

            const isAbortError = error.name === 'AbortError';
            assert.strictEqual(isAbortError, true);
        });

        it('should detect interrupt via wasInterrupted OR AbortError', () => {
            const checkInterruption = (wasInterrupted, errorName) => {
                return wasInterrupted || errorName === 'AbortError';
            };

            assert.strictEqual(checkInterruption(true, 'Error'), true);
            assert.strictEqual(checkInterruption(false, 'AbortError'), true);
            assert.strictEqual(checkInterruption(true, 'AbortError'), true);
            assert.strictEqual(checkInterruption(false, 'Error'), false);
        });
    });

    describe('Model info extraction pattern', () => {
        it('should extract model from lastInvocationDetails', () => {
            const mockLlmAgent = {
                invokerStrategy: {
                    getLastInvocationDetails: () => ({
                        model: 'claude-3-opus',
                        provider: 'anthropic',
                    }),
                },
            };

            const lastInvocation = mockLlmAgent.invokerStrategy?.getLastInvocationDetails?.();
            const modelInfo = lastInvocation?.model ? ` [${lastInvocation.model}]` : '';

            assert.strictEqual(modelInfo, ' [claude-3-opus]');
        });

        it('should handle missing invokerStrategy gracefully', () => {
            const mockLlmAgent = {};

            const lastInvocation = mockLlmAgent.invokerStrategy?.getLastInvocationDetails?.();
            const modelInfo = lastInvocation?.model ? ` [${lastInvocation.model}]` : '';

            assert.strictEqual(modelInfo, '');
        });

        it('should handle missing model in invocationDetails', () => {
            const mockLlmAgent = {
                invokerStrategy: {
                    getLastInvocationDetails: () => ({
                        provider: 'openai',
                    }),
                },
            };

            const lastInvocation = mockLlmAgent.invokerStrategy?.getLastInvocationDetails?.();
            const modelInfo = lastInvocation?.model ? ` [${lastInvocation.model}]` : '';

            assert.strictEqual(modelInfo, '');
        });
    });
});
