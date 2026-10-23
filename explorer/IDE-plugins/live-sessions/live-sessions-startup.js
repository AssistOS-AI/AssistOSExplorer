import { isAdminUser } from '../../services/auth/adminUser.js';
import { listLiveSessionsDetailed } from './live-sessions-api.js';
import {
    clearEmbeddedTerminalKey, countNeedsAttention, publishCue, queueEmbeddedRestore, readEmbeddedTerminalKey,
} from './live-sessions-state.js';

// Explorer start runs once per page: assistOS is created once, while the toolbar button can be mounted again.
const startedFor = new WeakSet();

// One shell-list read for administrators. It feeds the return cue and, when a terminal was embedded before the
// reload, asks `openPanel` for the panel, which re-attaches it as a new owner view through the attach-token flow.
// It makes no timer and no second request; the panel's own five-second poll keeps the cue current afterwards.
export async function runLiveSessionsStartup({ openPanel, host = globalThis.assistOS } = {}) {
    if (!host?.user || startedFor.has(host)) return false;
    startedFor.add(host);
    if (!isAdminUser(host.user)) return false;
    const stored = readEmbeddedTerminalKey();
    let rows;
    try {
        rows = (await listLiveSessionsDetailed()).rows;
    } catch (_) {
        if (stored) clearEmbeddedTerminalKey();
        return false;
    }
    publishCue(countNeedsAttention(rows));
    if (!stored) return false;
    // The key is also cleared when the panel is closed, so an explicit close during this read wins.
    const row = rows.find((candidate) => candidate.id === stored.sessionId);
    if (readEmbeddedTerminalKey()?.viewId !== stored.viewId || !row?.isOwner || row.status === 'exited') {
        clearEmbeddedTerminalKey();
        return false;
    }
    queueEmbeddedRestore(stored);
    if (!openPanel?.()) {
        queueEmbeddedRestore(null);
        clearEmbeddedTerminalKey();
        return false;
    }
    return true;
}
