import { withLock } from './roboflow/storage.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findProjectRecord } from './project-storage.mjs';
import { ConversationSessionStore } from '../copilot/src/lib/conversationSessionStore.mjs';
import { assertSafeAchillesPrivatePath } from '../copilot/src/lib/privateDataRoot.mjs';
import { scanSummaryLines, validRange } from '../shared/impact-summary.mjs';

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

export async function conversationSummaries(robotStore, workspaceRoot, sessionId) {
    if (!uuid(sessionId)) throw missing();
    const sessionFile = findProjectRecord({ dataDir: robotStore.dataDir, workspaceRoot }, 'session', sessionId);
    if (!sessionFile) throw missing();
    const cwd = path.dirname(path.dirname(path.dirname(sessionFile)));
    const store = new ConversationSessionStore({ workingDir: cwd });
    const logPath = messageId => {
        if (!uuid(messageId)) throw new Error('Invalid summary message');
        return assertSafeAchillesPrivatePath(cwd, `logs/${sessionId}/${messageId}.log`, { type: 'file' });
    };
    const session = await store.ensureSummaryIndex(sessionId);
    const messageRefs = new Map((session.summaryRefs || []).map(ref => [ref.messageId, ref.ranges]));
    const logRefs = new Map((session.summaryLogRefs || []).map(ref => [ref.messageId, ref.ranges]));
    const summaries = [];
    for (const message of session.messages.filter(entry => entry.role === 'assistant')) {
        const seen = new Set();
        const append = text => {
            text = text.trim();
            if (text && !seen.has(text)) { summaries.push({ messageId: message.id, text }); seen.add(text); }
        };
        const ranges = logRefs.get(message.id) || [];
        if (ranges.length) for (const item of await readRanges(logPath(message.id), ranges)) append(item.text);
        for (const range of messageRefs.get(message.id) || []) {
            if (!validRange(range, message.text.length)) throw new Error('Invalid summary message reference');
            append(message.text.slice(range.start, range.end));
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
        return { summaries, active: !['completed', 'failed', 'stopped', 'interrupted'].includes(instance.state) };
    }));
}
