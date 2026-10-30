import fs from 'node:fs';
import path from 'node:path';

import { readProcMasks } from '../sandbox/procMasks.mjs';

// The sandbox preflight (computed once at worker start, then cached: the runtime adapter methods are synchronous).
// It passes only when every tool the sandbox chain needs is present and executable and the worker container's /proc
// masks are readable and classifiable (decision M-4: the launcher re-applies them inside every sandbox).

export const SANDBOX_TOOLS = Object.freeze(['setpriv', 'unshare', 'nsenter', 'mount', 'umount', 'ip', 'nft']);
export const BWRAP_PATH = '/usr/bin/bwrap';
export const TOOL_SEARCH_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function findTool(name, searchPath, access) {
    for (const directory of searchPath.split(':')) {
        try {
            access(path.join(directory, name), fs.constants.X_OK);
            return path.join(directory, name);
        } catch { /* next directory */ }
    }
    return null;
}

// Returns {ok, missing: string[], masks: [...], reason: string|null}. `access` and `masks` are injection points for tests.
export function runSandboxPreflight({ searchPath = TOOL_SEARCH_PATH, access = fs.accessSync, readMasks = readProcMasks, bwrap = BWRAP_PATH } = {}) {
    const missing = SANDBOX_TOOLS.filter((name) => findTool(name, searchPath, access) === null);
    try { access(bwrap, fs.constants.X_OK); } catch { missing.push('bwrap'); }
    let masks = [];
    let reason = missing.length > 0 ? `missing tools: ${missing.join(', ')}` : null;
    try {
        masks = readMasks();
    } catch (error) {
        reason = reason ?? `proc masks unavailable: ${error?.code ?? error?.message ?? 'unknown'}`;
        return Object.freeze({ ok: false, missing, masks: [], reason });
    }
    return Object.freeze({ ok: missing.length === 0, missing, masks, reason });
}
