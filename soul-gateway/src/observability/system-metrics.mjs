/**
 * System metrics store — collects live runtime health indicators.
 *
 * Exposed via GET /management/metrics/system.
 */
export class SystemMetricsStore {
    constructor(appCtx) {
        this.appCtx = appCtx;
        this._timer = null;
    }

    /** Start periodic sampling. */
    start(intervalMs) {
        this._timer = setInterval(() => this._sample(), intervalMs);
        this._timer.unref();
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    _sample() {
        // Placeholder — real sampling added when execution engine and broadcast hub exist
    }

    /** Return a snapshot of current system metrics. */
    collect() {
        const mem = process.memoryUsage();
        const pool = this.appCtx.pool;

        const dbMetrics = pool
            ? {
                  total: pool.totalCount,
                  idle: pool.idleCount,
                  waiting: pool.waitingCount,
              }
            : { total: 0, idle: 0, waiting: 0 };

        return {
            process: {
                rss: mem.rss,
                heapUsed: mem.heapUsed,
                heapTotal: mem.heapTotal,
                external: mem.external,
                uptime: Math.round(process.uptime()),
            },
            db: dbMetrics,
            modelQueue: {}, // populated when ConcurrencyController exists
            loopDetector: {}, // populated when loop detector exists
            streams: {
                ws: 0, // populated when BroadcastHub exists
                sse: 0,
            },
            snapshotGeneration: this.appCtx.snapshotGeneration,
        };
    }
}
