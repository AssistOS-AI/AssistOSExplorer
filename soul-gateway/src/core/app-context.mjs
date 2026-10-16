/**
 * Application context — the single object passed to every subsystem.
 *
 * Created once during bootstrap and frozen. Subsystems add their
 * registries and services to the `services` bag during boot.
 */
export function createAppContext({ config, pool, log }) {
    return {
        config,
        pool,
        log,
        /** Mutable bag — subsystems register services here during boot. */
        services: {},
        /** Set to true once shutdown begins. Checked by request handlers. */
        draining: false,
        /** Current runtime snapshot generation (atomically swapped). */
        snapshotGeneration: 0,
        /** Boot timestamp. */
        startedAt: Date.now(),
    };
}
