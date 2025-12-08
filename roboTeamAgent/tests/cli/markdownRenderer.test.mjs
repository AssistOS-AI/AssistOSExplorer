/**
 * Tests for MarkdownRenderer module.
 *
 * Tests the custom terminal markdown renderer with ANSI styling.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// ============================================================================
// MarkdownRenderer Tests
// ============================================================================

describe('MarkdownRenderer', () => {
    let renderMarkdown;

    beforeEach(async () => {
        const module = await import('../src/ui/MarkdownRenderer.mjs');
        renderMarkdown = module.renderMarkdown;
    });

    describe('Basic Rendering', () => {
        it('should render plain text unchanged (except inline processing)', () => {
            const result = renderMarkdown('Hello world');
            assert.ok(result.includes('Hello world'));
        });

        it('should handle empty string', () => {
            const result = renderMarkdown('');
            assert.strictEqual(result, '');
        });

        it('should convert non-string to string', () => {
            const result = renderMarkdown(123);
            assert.strictEqual(result, '123');
        });

        it('should convert null to string', () => {
            const result = renderMarkdown(null);
            assert.strictEqual(result, 'null');
        });

        it('should convert undefined to string', () => {
            const result = renderMarkdown(undefined);
            assert.strictEqual(result, 'undefined');
        });
    });

    describe('Headers', () => {
        it('should render H1 with bold green and underline', () => {
            const result = renderMarkdown('# Main Title');

            assert.ok(result.includes('\x1b[1m'), 'Should contain bold');
            assert.ok(result.includes('\x1b[32m'), 'Should contain green');
            assert.ok(result.includes('Main Title'));
            assert.ok(result.includes('─'), 'Should contain horizontal rule');
        });

        it('should render H2 with bold yellow', () => {
            const result = renderMarkdown('## Section Title');

            assert.ok(result.includes('\x1b[1m'), 'Should contain bold');
            assert.ok(result.includes('\x1b[33m'), 'Should contain yellow');
            assert.ok(result.includes('Section Title'));
        });

        it('should render H3 with bold cyan', () => {
            const result = renderMarkdown('### Subsection');

            assert.ok(result.includes('\x1b[1m'), 'Should contain bold');
            assert.ok(result.includes('\x1b[36m'), 'Should contain cyan');
            assert.ok(result.includes('Subsection'));
        });

        it('should render H4 with bold blue', () => {
            const result = renderMarkdown('#### Sub-subsection');

            assert.ok(result.includes('\x1b[1m'), 'Should contain bold');
            assert.ok(result.includes('\x1b[34m'), 'Should contain blue');
            assert.ok(result.includes('Sub-subsection'));
        });

        it('should strip header markers', () => {
            const result = renderMarkdown('## Test');
            assert.ok(!result.includes('##'), 'Should not contain ## markers');
        });
    });

    describe('Inline Formatting', () => {
        it('should render inline code with cyan', () => {
            const result = renderMarkdown('Use `console.log()` for output');

            assert.ok(result.includes('\x1b[36m'), 'Should contain cyan');
            assert.ok(result.includes('console.log()'));
            assert.ok(!result.includes('`'), 'Should not contain backticks');
        });

        it('should render bold text', () => {
            const result = renderMarkdown('This is **bold** text');

            assert.ok(result.includes('\x1b[1m'), 'Should contain bold');
            assert.ok(result.includes('bold'));
            assert.ok(!result.includes('**'), 'Should not contain **');
        });

        it('should render italic text with asterisks', () => {
            const result = renderMarkdown('This is *italic* text');

            assert.ok(result.includes('\x1b[3m'), 'Should contain italic');
            assert.ok(result.includes('italic'));
        });

        it('should render italic text with underscores', () => {
            const result = renderMarkdown('This is _italic_ text');

            assert.ok(result.includes('\x1b[3m'), 'Should contain italic');
            assert.ok(result.includes('italic'));
        });

        it('should render links with underline and URL in dim', () => {
            const result = renderMarkdown('Check [this link](https://example.com)');

            assert.ok(result.includes('\x1b[4m'), 'Should contain underline');
            assert.ok(result.includes('this link'));
            assert.ok(result.includes('https://example.com'));
            assert.ok(result.includes('\x1b[2m'), 'Should contain dim for URL');
        });

        it('should handle multiple inline styles in one line', () => {
            const result = renderMarkdown('**Bold** and `code` and *italic*');

            assert.ok(result.includes('Bold'));
            assert.ok(result.includes('code'));
            assert.ok(result.includes('italic'));
        });
    });

    describe('Lists', () => {
        it('should render unordered list with dash', () => {
            const result = renderMarkdown('- First item');

            assert.ok(result.includes('•'), 'Should contain bullet');
            assert.ok(result.includes('First item'));
            assert.ok(!result.includes('- '), 'Should not contain original dash');
        });

        it('should render unordered list with asterisk', () => {
            const result = renderMarkdown('* Second item');

            assert.ok(result.includes('•'), 'Should contain bullet');
            assert.ok(result.includes('Second item'));
        });

        it('should render ordered list', () => {
            const result = renderMarkdown('1. First step');

            assert.ok(result.includes('1.'), 'Should contain number');
            assert.ok(result.includes('First step'));
        });

        it('should preserve list indentation', () => {
            const result = renderMarkdown('  - Nested item');

            assert.ok(result.includes('  '), 'Should preserve indent');
            assert.ok(result.includes('•'));
        });

        it('should process inline formatting in list items', () => {
            const result = renderMarkdown('- Item with **bold** text');

            assert.ok(result.includes('•'));
            assert.ok(result.includes('\x1b[1m'), 'Should contain bold');
        });
    });

    describe('Blockquotes', () => {
        it('should render blockquote with vertical bar', () => {
            const result = renderMarkdown('> This is a quote');

            assert.ok(result.includes('│'), 'Should contain vertical bar');
            assert.ok(result.includes('This is a quote'));
            assert.ok(result.includes('\x1b[2m'), 'Should be dim');
        });

        it('should render empty blockquote line', () => {
            const result = renderMarkdown('>');

            assert.ok(result.includes('│'), 'Should contain vertical bar');
        });

        it('should process inline formatting in blockquotes', () => {
            const result = renderMarkdown('> Quote with **bold**');

            assert.ok(result.includes('│'));
            assert.ok(result.includes('\x1b[1m'), 'Should contain bold');
        });
    });

    describe('Horizontal Rules', () => {
        it('should render --- as horizontal rule', () => {
            const result = renderMarkdown('---');

            assert.ok(result.includes('─'), 'Should contain horizontal line');
            assert.ok(!result.includes('---'));
        });

        it('should render *** as horizontal rule', () => {
            const result = renderMarkdown('***');

            assert.ok(result.includes('─'), 'Should contain horizontal line');
        });

        it('should render ___ as horizontal rule', () => {
            const result = renderMarkdown('___');

            assert.ok(result.includes('─'), 'Should contain horizontal line');
        });

        it('should render longer rules', () => {
            const result = renderMarkdown('-----');

            assert.ok(result.includes('─'), 'Should contain horizontal line');
        });
    });

    describe('Code Blocks', () => {
        it('should render code block with borders', () => {
            const markdown = '```\ncode here\n```';
            const result = renderMarkdown(markdown);

            assert.ok(result.includes('┌'), 'Should contain top border');
            assert.ok(result.includes('└'), 'Should contain bottom border');
            assert.ok(result.includes('│'), 'Should contain side border');
            assert.ok(result.includes('code here'));
        });

        it('should show language label if provided', () => {
            const markdown = '```javascript\nconst x = 1;\n```';
            const result = renderMarkdown(markdown);

            assert.ok(result.includes('javascript'), 'Should contain language label');
        });

        it('should preserve code content as-is', () => {
            const markdown = '```\n**not bold**\n```';
            const result = renderMarkdown(markdown);

            // Inside code block, markdown should not be processed
            assert.ok(result.includes('**not bold**'), 'Should preserve markdown in code');
        });

        it('should handle unclosed code block', () => {
            const markdown = '```javascript\nconst x = 1;';
            const result = renderMarkdown(markdown);

            // Should still render and close the block
            assert.ok(result.includes('javascript'));
            assert.ok(result.includes('const x = 1;'));
            assert.ok(result.includes('└'), 'Should contain closing border');
        });

        it('should handle code block with indented delimiter', () => {
            const markdown = '  ```\ncode\n  ```';
            const result = renderMarkdown(markdown);

            assert.ok(result.includes('code'));
        });
    });

    describe('Multiline Content', () => {
        it('should handle multiple paragraphs', () => {
            const markdown = 'First paragraph\n\nSecond paragraph';
            const result = renderMarkdown(markdown);

            assert.ok(result.includes('First paragraph'));
            assert.ok(result.includes('Second paragraph'));
        });

        it('should handle mixed content types', () => {
            const markdown = `# Title

Some text with **bold**.

- List item 1
- List item 2

\`\`\`
code
\`\`\`

> A quote`;
            const result = renderMarkdown(markdown);

            assert.ok(result.includes('Title'));
            assert.ok(result.includes('bold'));
            assert.ok(result.includes('•'));
            assert.ok(result.includes('code'));
            assert.ok(result.includes('│'));
        });
    });

    describe('Edge Cases', () => {
        it('should handle consecutive headers', () => {
            const markdown = '# H1\n## H2\n### H3';
            const result = renderMarkdown(markdown);

            assert.ok(result.includes('H1'));
            assert.ok(result.includes('H2'));
            assert.ok(result.includes('H3'));
        });

        it('should not match bold inside underscores for snake_case', () => {
            const result = renderMarkdown('variable_name_here');

            // Should not italicize parts of snake_case identifiers
            assert.ok(result.includes('variable_name_here'));
        });

        it('should handle empty lines', () => {
            const markdown = 'Line 1\n\n\nLine 2';
            const result = renderMarkdown(markdown);

            assert.ok(result.includes('Line 1'));
            assert.ok(result.includes('Line 2'));
        });

        it('should handle line with only whitespace', () => {
            const markdown = 'Line 1\n   \nLine 2';
            const result = renderMarkdown(markdown);

            assert.ok(result.includes('Line 1'));
            assert.ok(result.includes('Line 2'));
        });

        it('should not double-process bold markers', () => {
            // Ensure ***text*** doesn't break
            const result = renderMarkdown('***both***');

            // Should have both bold and italic applied
            assert.ok(result.includes('both'));
        });
    });
});

// ============================================================================
// ANSI Code Constants Tests
// ============================================================================

describe('MarkdownRenderer - ANSI Codes', () => {
    let renderMarkdown;

    beforeEach(async () => {
        const module = await import('../src/ui/MarkdownRenderer.mjs');
        renderMarkdown = module.renderMarkdown;
    });

    it('should include reset code after styled text', () => {
        const result = renderMarkdown('**bold**');
        assert.ok(result.includes('\x1b[0m'), 'Should contain reset code');
    });

    it('should use correct ANSI codes', () => {
        const testCases = [
            { input: '**bold**', expected: '\x1b[1m' },        // bold
            { input: '*italic*', expected: '\x1b[3m' },       // italic
            { input: '_italic_', expected: '\x1b[3m' },       // italic
            { input: '`code`', expected: '\x1b[36m' },        // cyan
            { input: '[link](url)', expected: '\x1b[4m' },    // underline
        ];

        for (const { input, expected } of testCases) {
            const result = renderMarkdown(input);
            assert.ok(result.includes(expected), `${input} should contain ${expected}`);
        }
    });
});
