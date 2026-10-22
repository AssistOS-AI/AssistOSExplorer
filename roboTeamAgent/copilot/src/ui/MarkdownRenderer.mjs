/**
 * MarkdownRenderer - Custom terminal markdown renderer with ANSI styling.
 *
 * Transforms markdown text to ANSI-styled terminal output without external dependencies.
 *
 * @module ui/MarkdownRenderer
 */

import { baseTheme } from './themes/base.mjs';

/**
 * Get colors from theme or use baseTheme as fallback
 * @param {Object} [theme] - Optional theme object
 * @returns {Object} - Colors object
 */
function getColors(theme) {
    return (theme && theme.colors) || baseTheme.colors;
}

/**
 * Process inline markdown elements (bold, italic, code, links).
 * @param {string} text - Text to process
 * @param {Object} colors - Colors object from theme
 * @returns {string} - Text with ANSI styling
 */
function processInline(text, colors) {
    // Inline code (must be before bold/italic to avoid conflicts)
    text = text.replace(/`([^`]+)`/g, `${colors.cyan}$1${colors.reset}`);

    // Bold **text**
    text = text.replace(/\*\*([^*]+)\*\*/g, `${colors.bold}$1${colors.reset}`);

    // Italic *text* (be careful not to match list bullets or bold markers)
    text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, `${colors.italic}$1${colors.reset}`);

    // Italic _text_
    text = text.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, `${colors.italic}$1${colors.reset}`);

    // Links [text](url)
    text = text.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        `${colors.underline}$1${colors.reset} ${colors.dim}($2)${colors.reset}`
    );

    return text;
}

/**
 * Process a single line of markdown (headers, lists, blockquotes, etc.).
 * @param {string} line - Line to process
 * @param {Object} colors - Colors object from theme
 * @returns {string} - Line with ANSI styling
 */
function processLine(line, colors) {
    // Headers (check longer prefixes first)
    if (line.startsWith('#### ')) {
        return `${colors.bold}${colors.blue}${line.slice(5)}${colors.reset}`;
    }
    if (line.startsWith('### ')) {
        return `${colors.bold}${colors.cyan}${line.slice(4)}${colors.reset}`;
    }
    if (line.startsWith('## ')) {
        return `${colors.bold}${colors.yellow}${line.slice(3)}${colors.reset}`;
    }
    if (line.startsWith('# ')) {
        return `${colors.bold}${colors.green}${line.slice(2)}${colors.reset}\n${'─'.repeat(40)}`;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(line.trim()) || /^\*{3,}$/.test(line.trim()) || /^_{3,}$/.test(line.trim())) {
        return `${colors.dim}${'─'.repeat(40)}${colors.reset}`;
    }

    // Blockquote
    if (line.startsWith('> ')) {
        return `${colors.dim}│ ${processInline(line.slice(2), colors)}${colors.reset}`;
    }
    if (line === '>') {
        return `${colors.dim}│${colors.reset}`;
    }

    // Unordered lists (- or *)
    const unorderedMatch = line.match(/^(\s*)([-*])\s+(.*)$/);
    if (unorderedMatch) {
        const [, indent, , content] = unorderedMatch;
        return `${indent}  • ${processInline(content, colors)}`;
    }

    // Ordered lists (1., 2., etc.)
    const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (orderedMatch) {
        const [, indent, num, content] = orderedMatch;
        return `${indent}  ${num}. ${processInline(content, colors)}`;
    }

    // Regular text - process inline elements
    return processInline(line, colors);
}

/**
 * Parse a markdown table row into cells.
 * @param {string} row - Table row string
 * @returns {string[]} - Array of cell values (trimmed)
 */
function parseTableRow(row) {
    // Remove leading/trailing pipes and split by |
    const trimmed = row.trim().replace(/^\||\|$/g, '');
    return trimmed.split('|').map(cell => cell.trim());
}

/**
 * Check if a line is a table separator row (e.g., |---|---|)
 * @param {string} line - Line to check
 * @returns {boolean}
 */
function isTableSeparator(line) {
    const trimmed = line.trim();
    // Must have pipes and only contain |, -, :, and spaces
    return trimmed.includes('|') && /^[\s|:\-]+$/.test(trimmed);
}

/**
 * Check if a line looks like a table row.
 * @param {string} line - Line to check
 * @returns {boolean}
 */
function isTableRow(line) {
    const trimmed = line.trim();
    // Must start and end with | or have | somewhere in between
    return trimmed.includes('|') && !trimmed.startsWith('```');
}

/**
 * Format markdown tables with aligned columns.
 * @param {string} text - Full markdown text
 * @returns {string} - Text with aligned tables
 */
function formatTables(text) {
    const lines = text.split('\n');
    const result = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Check if this could be the start of a table (header row)
        if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
            // Found a table - collect all rows
            const tableLines = [line];
            let j = i + 1;

            // Collect separator and all following table rows
            while (j < lines.length && (isTableSeparator(lines[j]) || isTableRow(lines[j]))) {
                tableLines.push(lines[j]);
                j++;
            }

            // Parse all rows into cells
            const parsedRows = tableLines.map(parseTableRow);

            // Calculate max width for each column
            const colCount = Math.max(...parsedRows.map(row => row.length));
            const colWidths = new Array(colCount).fill(0);

            for (const row of parsedRows) {
                for (let c = 0; c < row.length; c++) {
                    // For separator rows, minimum width is 3 (---)
                    const cellLen = isTableSeparator(tableLines[parsedRows.indexOf(row)])
                        ? 3
                        : row[c].length;
                    colWidths[c] = Math.max(colWidths[c], cellLen);
                }
            }

            // Rebuild aligned table
            for (let r = 0; r < tableLines.length; r++) {
                const originalLine = tableLines[r];
                const cells = parsedRows[r];
                const isSeparator = isTableSeparator(originalLine);

                const alignedCells = [];
                for (let c = 0; c < colCount; c++) {
                    const cell = cells[c] || '';
                    const width = colWidths[c];

                    if (isSeparator) {
                        // Rebuild separator with proper width (no spaces)
                        alignedCells.push('-'.repeat(width + 2)); // +2 to account for spaces in content rows
                    } else {
                        // Pad cell content to column width
                        alignedCells.push(' ' + cell.padEnd(width) + ' ');
                    }
                }

                if (isSeparator) {
                    result.push('|' + alignedCells.join('|') + '|');
                } else {
                    result.push('|' + alignedCells.join('|') + '|');
                }
            }

            i = j;
        } else {
            result.push(line);
            i++;
        }
    }

    return result.join('\n');
}

/**
 * Render markdown text with ANSI terminal styling.
 * @param {string} text - Markdown text to render
 * @param {Object} [options] - Render options
 * @param {Object} [options.theme] - Theme object (uses baseTheme if not provided)
 * @returns {string} - Text with ANSI styling for terminal display
 */
export function renderMarkdown(text, options = {}) {
    if (typeof text !== 'string') {
        return String(text);
    }

    const colors = getColors(options.theme);

    // Pre-process: align tables before other formatting
    text = formatTables(text);

    const lines = text.split('\n');
    const output = [];
    let inCodeBlock = false;
    let codeBlockLang = '';

    for (const line of lines) {
        // Check for code block delimiter
        if (line.trimStart().startsWith('```')) {
            const trimmedLine = line.trimStart();
            if (!inCodeBlock) {
                // Starting a code block
                inCodeBlock = true;
                codeBlockLang = trimmedLine.slice(3).trim();
                const langLabel = codeBlockLang ? ` ${codeBlockLang} ` : '';
                const padding = 40 - langLabel.length;
                output.push(`${colors.dim}┌─${langLabel}${'─'.repeat(Math.max(0, padding))}${colors.reset}`);
            } else {
                // Ending a code block
                inCodeBlock = false;
                codeBlockLang = '';
                output.push(`${colors.dim}└${'─'.repeat(42)}${colors.reset}`);
            }
            continue;
        }

        if (inCodeBlock) {
            // Inside code block - preserve formatting, add border
            output.push(`${colors.dim}│${colors.reset} ${line}`);
            continue;
        }

        // Process regular markdown line
        output.push(processLine(line, colors));
    }

    // Handle unclosed code block
    if (inCodeBlock) {
        output.push(`${colors.dim}└${'─'.repeat(42)}${colors.reset}`);
    }

    return output.join('\n');
}

export { formatTables };
export default renderMarkdown;
