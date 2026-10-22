import fs from 'node:fs/promises';
import { scanSummaryLines } from './impact-summary.mjs';

// Resume at the last complete line. An unfinished line stays only in the source file.
export async function advanceSummaryFile(file, index, { start, end, assistant, complete = false, outputId = '' }) {
    if (!assistant) { index.state = {}; index.outputId = null; return []; }
    if (index.outputId !== outputId || index.state?.end !== start) index.state = {};
    const cursor = index.state.cursor ?? start;
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let text;
    try {
        if (!(await handle.stat()).isFile() || cursor < 0 || cursor > end) throw new Error('Invalid summary source');
        const buffer = Buffer.alloc(end - cursor);
        let read = 0;
        while (read < buffer.length) {
            const chunk = await handle.read(buffer, read, buffer.length - read, cursor + read);
            if (!chunk.bytesRead) throw new Error('Summary source changed');
            read += chunk.bytesRead;
        }
        text = buffer.toString('utf8');
    } finally { await handle.close(); }
    const scanned = scanSummaryLines(text, { offset: cursor, bytes: true, final: complete, state: index.state });
    const ranges = scanned.ranges;
    index.state = complete ? {} : { ...scanned, ranges: [], end };
    index.outputId = complete ? null : outputId;
    return ranges;
}
