/**
 * Clipboard utility - Cross-platform clipboard access for copy/paste operations.
 *
 * Supports:
 * - Linux: xclip or xsel
 * - macOS: pbcopy/pbpaste
 * - Windows: clip/PowerShell
 */

import { execSync, spawnSync } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Detect the current platform and available clipboard tools.
 * @returns {{ copy: string[], paste: string[] } | null} Commands to use, or null if unavailable
 */
function detectClipboardCommands() {
    const os = platform();

    if (os === 'darwin') {
        // macOS - pbcopy/pbpaste are always available
        return {
            copy: ['pbcopy'],
            paste: ['pbpaste'],
        };
    }

    if (os === 'win32') {
        // Windows - clip for copy, PowerShell for paste
        return {
            copy: ['clip'],
            paste: ['powershell', '-command', 'Get-Clipboard'],
        };
    }

    // Linux/Unix - try xclip first, then xsel
    try {
        execSync('which xclip', { stdio: 'ignore' });
        return {
            copy: ['xclip', '-selection', 'clipboard'],
            paste: ['xclip', '-selection', 'clipboard', '-o'],
        };
    } catch {
        // xclip not available, try xsel
    }

    try {
        execSync('which xsel', { stdio: 'ignore' });
        return {
            copy: ['xsel', '--clipboard', '--input'],
            paste: ['xsel', '--clipboard', '--output'],
        };
    } catch {
        // xsel not available either
    }

    // No clipboard tool found
    return null;
}

// Cache the detected commands (undefined = not checked yet, null = no tools found)
let cachedCommands = undefined;

/**
 * Get clipboard commands, using cached value if available.
 * @returns {{ copy: string[], paste: string[] } | null}
 */
function getCommands() {
    if (cachedCommands === undefined) {
        cachedCommands = detectClipboardCommands();
    }
    return cachedCommands;
}

/**
 * Copy text to the system clipboard.
 * @param {string} text - Text to copy
 * @returns {boolean} True if successful
 */
export function copyToClipboard(text) {
    const commands = getCommands();
    if (!commands) {
        return false;
    }

    try {
        const [cmd, ...args] = commands.copy;
        const result = spawnSync(cmd, args, {
            input: text,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        return result.status === 0;
    } catch {
        return false;
    }
}

/**
 * Paste text from the system clipboard.
 * @returns {string | null} Clipboard contents, or null if unavailable
 */
export function pasteFromClipboard() {
    const commands = getCommands();
    if (!commands) {
        return null;
    }

    try {
        const [cmd, ...args] = commands.paste;
        const result = spawnSync(cmd, args, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (result.status === 0) {
            // Remove trailing newline that some tools add
            return result.stdout.replace(/\r?\n$/, '');
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Check if clipboard operations are available on this system.
 * @returns {boolean} True if clipboard is available
 */
export function isClipboardAvailable() {
    return getCommands() !== null;
}

export default {
    copy: copyToClipboard,
    paste: pasteFromClipboard,
    isAvailable: isClipboardAvailable,
};
