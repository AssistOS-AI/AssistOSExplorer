export function getTerminalSize(stream = process.stdout) {
    let columns = stream.columns;
    let rows = stream.rows;

    if (typeof stream.getWindowSize === 'function') {
        try {
            const measured = stream.getWindowSize();
            if (Array.isArray(measured)) {
                columns = measured[0] || columns;
                rows = measured[1] || rows;
            }
        } catch {
            // Fall back to the stream's cached dimensions.
        }
    }

    return {
        columns: Math.max(8, columns || 80),
        rows: Math.max(1, rows || 24),
    };
}
