import { withLock } from './roboflow/storage.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findProjectRecord } from './project-storage.mjs';
import { ConversationSessionStore } from '../copilot/src/lib/storage/conversationSessionStore.mjs';
import { readAlaSession } from '../copilot/src/lib/execution/alaTranscript.mjs';
import { scanSummaryLines, summaryRanges, validRange } from '../shared/impact-summary.mjs';

const missing = () => Object.assign(new Error('Summary source not found'), { statusCode: 404 });
const uuid = value => /^[a-f0-9-]{36}$/.test(value || '');

async function readRanges(file, ranges) {
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('Invalid summary source');
        const result = [];
        for (const range of ranges) {
            if (!validRange(range, stat.size)) throw new Error('Invalid summary reference');
            const buffer = Buffer.alloc(range.end - range.start);
            let read = 0;
            while (read < buffer.length) {
                const chunk = await handle.read(buffer, read, buffer.length - read, range.start + read);
                if (!chunk.bytesRead) throw new Error('Summary source changed while reading');
                read += chunk.bytesRead;
            }
            result.push({ ...range, text: buffer.toString('utf8').trim() });
        }
        return result;
    } finally { await handle.close(); }
}

// Human reports of a conversation are the marked blocks in ALA's recorded
// assistant output and final answers, read from the transcript on demand.
export async function conversationSummaries(robotStore, workspaceRoot, sessionId) {
    if (!uuid(sessionId)) throw missing();
    const sessionFile = findProjectRecord({ dataDir: robotStore.dataDir, workspaceRoot }, 'session', sessionId);
    if (!sessionFile) throw missing();
    const cwd = path.dirname(path.dirname(path.dirname(sessionFile)));
    const session = new ConversationSessionStore({ workingDir: cwd }).loadSession(sessionId);
    const alaTurns = new Map((readAlaSession(session.engine?.cwd || session.cwd || cwd, sessionId)?.turns || []).map(turn => [turn.turnId, turn]));
    const summaries = [];
    for (const message of session.messages.filter(entry => entry.role === 'assistant' && entry.context !== false)) {
        const turn = alaTurns.get(message.turnId);
        if (!turn) continue;
        const seen = new Set();
        const texts = [...turn.messages.filter(entry => entry.outputKind === 'assistant').map(entry => entry.text), turn.final || ''];
        for (const source of texts) {
            for (const range of summaryRanges(source)) {
                const text = source.slice(range.start, range.end).trim();
                if (text && !seen.has(text)) { summaries.push({ messageId: message.id, text }); seen.add(text); }
            }
        }
    }
    return { summaries, active: session.messages.some(message => message.status === 'pending') };
}

export async function workflowSummaries(service, flowId, instanceId) {
    // Share the runtime event queue so migration cannot race with output appends.
    return service._serialize(flowId, () => withLock(`summary-output:${flowId}:${instanceId}`, async () => {
        let flow = await service.store.get(flowId);
        let instance = flow?.instances.find(entry => entry.id === instanceId);
        if (!instance) throw missing();
        if (!instance.summaryOutputs?.result) {
            const outputs = { ...instance.summaryOutputs, result: { version: 1, ranges: [], state: {} } };
            // Historical raw logs do not distinguish assistant text from tool output.
            for (const suffix of ['result']) {
                try {
                    const text = await service.store.readOutput(flowId, instanceId, suffix);
                    outputs[suffix] = { version: 1, ranges: scanSummaryLines(text, { bytes: true }).ranges
                        .map(range => ({ ...range, attempt: instance.runtimeTaskId })), state: {} };
                } catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            await service.store.update(flowId, record => { record.instances.find(entry => entry.id === instanceId).summaryOutputs = outputs; });
            flow = await service.store.get(flowId);
            instance = flow.instances.find(entry => entry.id === instanceId);
        }
        const entries = [];
        for (const suffix of ['log', 'result']) {
            const ranges = instance.summaryOutputs[suffix]?.ranges || [];
            if (ranges.length) entries.push(...await readRanges(await service.store.outputPath(flowId, instanceId, suffix), ranges));
        }
        entries.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
        const seen = new Set();
        const summaries = entries.filter(entry => {
            const key = `${entry.attempt}:${entry.text}`;
            if (!entry.text || seen.has(key)) return false;
            seen.add(key); return true;
        }).map(({ text }) => ({ text }));
        return { summaries, active: !['completed', 'failed', 'paused'].includes(instance.state) };
    }));
}
