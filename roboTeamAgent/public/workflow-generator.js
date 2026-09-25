import { api } from './roboflow-api.js';

const POLL_INTERVAL_MS = 2000;

function sleep(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Generation cancelled')); }, { once: true });
    });
}

// Generation runs as a RoboTeam task; the page polls its status every couple of
// seconds and streams the task log tail while the graph is produced.
export async function generateGraph(description, { onProgress = () => {}, onLog = () => {}, signal } = {}) {
    signal?.throwIfAborted();
    const { id } = await api('api/roboflow/generations', { method: 'POST', body: { description }, signal });
    let lastLog;
    try {
        for (;;) {
            signal?.throwIfAborted();
            const state = await api(`api/roboflow/generations/${id}`, { signal, cache: 'no-store' });
            if (typeof state.log === 'string' && state.log !== lastLog) { lastLog = state.log; onLog(state.log); }
            onProgress(state.status);
            if (state.status === 'completed') return state.graph;
            if (state.status === 'failed') throw new Error(state.error || 'Generation failed');
            if (state.status === 'cancelled') throw new Error(state.error || 'Generation cancelled');
            await sleep(POLL_INTERVAL_MS, signal);
        }
    } catch (error) {
        await api(`api/roboflow/generations/${id}`, { method: 'DELETE' }).catch(() => {});
        throw error;
    }
}
