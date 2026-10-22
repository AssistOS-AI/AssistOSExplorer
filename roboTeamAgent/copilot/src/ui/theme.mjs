/**
 * UI Theme - Consistent styling constants and utilities
 *
 * This file re-exports from themes/base.mjs for backward compatibility.
 * New code should import directly from './themes/base.mjs'.
 */

// Import for local use in utility functions
import { colors, box, icons, semantic } from './themes/base.mjs';

// Re-export all theme constants from the centralized base theme
export { colors, box, icons, semantic };

/**
 * Style text with color
 */
export function style(text, ...styles) {
    const styleStr = styles.join('');
    return `${styleStr}${text}${colors.reset}`;
}

/**
 * Create a horizontal line
 */
export function line(width = 60, char = box.horizontal) {
    return char.repeat(width);
}

/**
 * Create a boxed header
 */
export function boxHeader(text, width = 60) {
    const padding = width - text.length - 2;
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;

    return [
        `${box.topLeft}${line(width, box.horizontal)}${box.topRight}`,
        `${box.vertical}${' '.repeat(leftPad)}${text}${' '.repeat(rightPad)}${box.vertical}`,
        `${box.bottomLeft}${line(width, box.horizontal)}${box.bottomRight}`,
    ].join('\n');
}

/**
 * Create a simple box around content
 */
export function simpleBox(content, options = {}) {
    const { width = 60, title = '', color = '' } = options;
    const lines = content.split('\n');
    const maxLen = Math.max(...lines.map(l => l.length), title.length);
    const boxWidth = Math.max(width, maxLen + 4);

    const result = [];

    // Top border with optional title
    if (title) {
        const titlePart = `${box.horizontal} ${title} `;
        const remaining = boxWidth - titlePart.length - 1;
        result.push(`${color}${box.topLeft}${titlePart}${line(remaining, box.horizontal)}${box.topRight}${colors.reset}`);
    } else {
        result.push(`${color}${box.topLeft}${line(boxWidth, box.horizontal)}${box.topRight}${colors.reset}`);
    }

    // Content
    for (const l of lines) {
        const padded = l.padEnd(boxWidth - 2);
        result.push(`${color}${box.vertical}${colors.reset} ${padded}${color}${box.vertical}${colors.reset}`);
    }

    // Bottom border
    result.push(`${color}${box.bottomLeft}${line(boxWidth, box.horizontal)}${box.bottomRight}${colors.reset}`);

    return result.join('\n');
}

/**
 * Format a table with proper borders
 */
export function table(headers, rows, options = {}) {
    const { minWidth = 10 } = options;

    // Calculate column widths
    const colWidths = headers.map((h, i) => {
        const maxContent = Math.max(
            h.length,
            ...rows.map(r => String(r[i] || '').length)
        );
        return Math.max(maxContent, minWidth);
    });

    const totalWidth = colWidths.reduce((a, b) => a + b, 0) + (colWidths.length * 3) + 1;

    // Build table
    const result = [];

    // Top border
    result.push(
        box.topLeft +
        colWidths.map(w => line(w + 2, box.horizontal)).join(box.tTop) +
        box.topRight
    );

    // Header row
    result.push(
        box.vertical +
        headers.map((h, i) => ` ${style(h.padEnd(colWidths[i]), colors.bold)} `).join(box.vertical) +
        box.vertical
    );

    // Header separator
    result.push(
        box.tLeft +
        colWidths.map(w => line(w + 2, box.horizontal)).join(box.cross) +
        box.tRight
    );

    // Data rows
    for (const row of rows) {
        result.push(
            box.vertical +
            row.map((cell, i) => ` ${String(cell || '').padEnd(colWidths[i])} `).join(box.vertical) +
            box.vertical
        );
    }

    // Bottom border
    result.push(
        box.bottomLeft +
        colWidths.map(w => line(w + 2, box.horizontal)).join(box.tBottom) +
        box.bottomRight
    );

    return result.join('\n');
}

/**
 * Format a list with bullets
 */
export function bulletList(items, options = {}) {
    const { indent = 2, bullet = icons.bullet, color = colors.cyan } = options;
    const prefix = ' '.repeat(indent);
    return items.map(item => `${prefix}${color}${bullet}${colors.reset} ${item}`).join('\n');
}

/**
 * Format a key-value display
 */
export function keyValue(pairs, options = {}) {
    const { separator = ':', keyColor = colors.cyan, indent = 0 } = options;
    const prefix = ' '.repeat(indent);
    const maxKeyLen = Math.max(...pairs.map(([k]) => k.length));

    return pairs
        .map(([key, value]) => `${prefix}${keyColor}${key.padEnd(maxKeyLen)}${colors.reset}${separator} ${value}`)
        .join('\n');
}

/**
 * Create a minimal header bar
 */
export function headerBar(text, width = 60) {
    const side = Math.floor((width - text.length - 2) / 2);
    return `${colors.dim}${line(side)}${colors.reset} ${style(text, colors.bold)} ${colors.dim}${line(side)}${colors.reset}`;
}

export default {
    colors,
    box,
    icons,
    semantic,
    style,
    line,
    boxHeader,
    simpleBox,
    table,
    bulletList,
    keyValue,
    headerBar,
};
