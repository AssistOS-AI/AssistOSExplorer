/**
 * discovery-scheduler.mjs — startup + periodic Ploinky agent reconciliation.
 *
 * Wraps the discovery client and the reconciler with the two run modes the
 * bootstrap needs:
 *
 *   - `runInitialPloinkyReconcile(appCtx)` — a single discovery+reconcile pass
 *     run during startup, AFTER provider bootstrap and BEFORE
 *     `installSnapshotServices(appCtx)`. At that point the snapshot service is
 *     not installed yet, so `performRuntimeRefresh` is a no-op; that is fine,
 *     because `installSnapshotServices` runs immediately afterwards and loads
 *     the freshly reconciled rows into the snapshot. Discovery failure is
 *     logged and swallowed so it can never crash startup.
 *
 *   - `startPloinkyDiscoveryTimer(appCtx)` — a ~60s interval that repeats
 *     discovery+reconcile while Soul Gateway runs as a Ploinky agent. By the
 *     time the timer first fires, the runtime-refresh service IS installed, so
 *     a reconcile that changes rows rebuilds the live snapshot. Returns the
 *     interval handle (unref'd so it never keeps the process alive); the
 *     bootstrap stores it on `appCtx.services.ploinkyDiscoveryTimer` and
 *     `shutdown.mjs` clears it.
 *
 * Both modes no-op cleanly when the Ploinky transport config is absent
 * (non-Ploinky/dev mode).
 */

import {
    discoverPloinkyAgents,
    isDiscoveryConfigured,
} from './discovery-client.mjs';
import { reconcilePloinkyAgents } from './reconcile-agents.mjs';

export const PLOINKY_DISCOVERY_INTERVAL_MS = 60_000;

/**
 * Run one discovery + reconcile pass. Never throws: discovery failures degrade
 * to "preserve existing rows" and are logged.
 *
 * @param {object} appCtx
 * @param {object} [options]
 * @param {string} [options.phase] Label for logs ('startup' | 'timer').
 * @returns {Promise<object|null>} reconcile summary, or null on skip/failure.
 */
export async function runPloinkyReconcileOnce(appCtx, options = {}) {
    const { log, config } = appCtx;
    const phase = options.phase || 'manual';

    if (!isDiscoveryConfigured(config)) {
        return null;
    }

    try {
        const discovery = await discoverPloinkyAgents(config, { log });
        const summary = await reconcilePloinkyAgents({ appCtx, discovery });
        return summary;
    } catch (err) {
        // Reconcile/discovery must never take down the gateway. Keep serving
        // whatever providers/models already exist.
        log?.warn?.('ploinky agent reconcile pass failed', {
            phase,
            error: err.message,
        });
        return null;
    }
}

/**
 * Startup pass. Runs before `installSnapshotServices(appCtx)`; the subsequent
 * snapshot load picks up any rows written here.
 *
 * @param {object} appCtx
 * @returns {Promise<object|null>}
 */
export async function runInitialPloinkyReconcile(appCtx) {
    return runPloinkyReconcileOnce(appCtx, { phase: 'startup' });
}

/**
 * Start the periodic reconcile timer. No-ops (returns null) when Ploinky is not
 * configured. The handle is unref'd so it does not keep the event loop alive.
 *
 * @param {object} appCtx
 * @param {object} [options]
 * @param {number} [options.intervalMs]
 * @returns {ReturnType<typeof setInterval>|null}
 */
export function startPloinkyDiscoveryTimer(appCtx, options = {}) {
    const { log, config } = appCtx;
    if (!isDiscoveryConfigured(config)) {
        return null;
    }

    const intervalMs = options.intervalMs || PLOINKY_DISCOVERY_INTERVAL_MS;
    const timer = setInterval(() => {
        void runPloinkyReconcileOnce(appCtx, { phase: 'timer' });
    }, intervalMs);

    if (typeof timer.unref === 'function') {
        timer.unref();
    }

    log?.info?.('ploinky agent discovery timer started', { intervalMs });
    return timer;
}

export default {
    PLOINKY_DISCOVERY_INTERVAL_MS,
    runPloinkyReconcileOnce,
    runInitialPloinkyReconcile,
    startPloinkyDiscoveryTimer,
};
