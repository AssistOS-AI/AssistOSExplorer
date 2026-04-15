/**
 * Structured JSON logger.
 * Outputs one JSON object per line to stdout/stderr.
 */
export function createLogger(name = 'soul-gateway') {
    function write(level, msg, meta) {
        const entry = {
            ts: new Date().toISOString(),
            level,
            name,
            msg,
            ...meta,
        };
        const out =
            level === 'error' || level === 'fatal'
                ? process.stderr
                : process.stdout;
        let line;
        try {
            line = JSON.stringify(entry);
        } catch (serErr) {
            line = JSON.stringify({
                ts: entry.ts,
                level,
                name,
                msg,
                _serializationError: serErr.message,
            });
        }
        out.write(line + '\n');
    }

    return {
        debug: (msg, meta) => write('debug', msg, meta),
        info: (msg, meta) => write('info', msg, meta),
        warn: (msg, meta) => write('warn', msg, meta),
        error: (msg, meta) => write('error', msg, meta),
        fatal: (msg, meta) => write('fatal', msg, meta),
    };
}
