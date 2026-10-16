import { api } from './roboflow-api.js';

const POLL_INTERVAL_MS = 2000;

function sleep(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error('Generation cancelled')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
        signal?.addEventListener('abort', abort, { once: true });
    });
}

// Generation runs as a RoboTeam task; the page polls its status every couple of
// seconds and streams the task log tail while the graph is produced.
export async function generateGraph(description, { onProgress = () => {}, onLog = () => {}, signal } = {}) {
    return (await runGeneration({ description }, { onProgress, onLog, signal })).graph;
}

export async function reviseGraph(workflow, previousDescription, description, options = {}) {
    return runGeneration({ workflow, previousDescription, description }, options);
}

async function runGeneration(input, { onProgress = () => {}, onLog = () => {}, signal, request = api } = {}) {
    signal?.throwIfAborted();
    // Do not abort the POST: its id is needed to cancel the server task even if
    // the user changes the description while the request is being accepted.
    const { id } = await request('api/roboflow/generations', { method: 'POST', body: input });
    let lastLog;
    try {
        for (;;) {
            signal?.throwIfAborted();
            const state = await request(`api/roboflow/generations/${id}`, { signal, cache: 'no-store' });
            if (typeof state.log === 'string' && state.log !== lastLog) { lastLog = state.log; onLog(state.log); }
            onProgress(state.status);
            if (state.status === 'completed') return state;
            if (state.status === 'failed') throw new Error(state.error || 'Generation failed');
            if (state.status === 'cancelled') throw new Error(state.error || 'Generation cancelled');
            await sleep(POLL_INTERVAL_MS, signal);
        }
    } catch (error) {
        await request(`api/roboflow/generations/${id}`, { method: 'DELETE' }).catch(() => {});
        throw error;
    }
}
