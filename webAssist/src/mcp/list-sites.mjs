#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveWebAssistDataRoot } from '../runtime/akuStore.mjs';
import { callerAccessFromEnvelope, formatToolError, publicError } from '../runtime/sessionAccess.mjs';

function safeParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

async function readStdinFallback() {
    if (process.stdin.isTTY) {
        return '';
    }
    return new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            data += chunk;
        });
        process.stdin.on('end', () => {
            resolve(data);
        });
        process.stdin.on('error', () => {
            resolve('');
        });
    });
}

// Site ids are an Explorer-user surface (settings component); visitors and
// guests are denied before any storage access. The data root is never returned.
export async function listSites({ access = null } = {}) {
    if (access?.explorerAccess !== true) {
        throw publicError('Access denied: Explorer access is required to list webAssist sites.');
    }
    const sitesDir = path.join(resolveWebAssistDataRoot({ allowMissing: true }), 'sites');

    try {
        const entries = await fs.readdir(sitesDir, { withFileTypes: true });
        const siteIds = entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();

        return {
            sites: siteIds,
            count: siteIds.length,
        };
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            return {
                sites: [],
                count: 0,
            };
        }
        throw error;
    }
}

async function main() {
    const rawInput = await readStdinFallback();
    const envelope = rawInput && rawInput.trim() ? safeParseJson(rawInput) : null;
    let access = null;
    try {
        access = await callerAccessFromEnvelope(envelope || {});
        const result = await listSites({ access });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${formatToolError(error, access)}\n`);
        process.exitCode = 1;
    }
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
    main().catch(() => {
        process.stderr.write('webAssist request failed.\n');
        process.exitCode = 1;
    });
}
