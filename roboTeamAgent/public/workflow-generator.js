export async function generateGraph(description, { onProgress = () => {}, signal } = {}) {
    const { createAgentClient } = await import('/MCPBrowserClient.js');
    const route = globalThis.ROBOTEAM_CONFIG?.routeKey || 'roboTeamAgent';
    const client = createAgentClient(new URL(`/${route}/mcp`, location.origin).href);
    let taskId, cancelling, rejectAbort;
    const cancelled = new Promise((resolve, reject) => { rejectAbort = reject; });
    const cancelTask = () => {
        if (!taskId || cancelling) return cancelling;
        cancelling = (async () => {
            try {
                const response = await fetch(`/auth/token?mutationRoute=${encodeURIComponent(route)}`, { credentials: 'include' });
                const proof = await response.json();
                if (!response.ok || !proof.browserMutation?.csrfToken) throw new Error('Could not authorize generation cancellation');
                const stopped = await fetch(`/${route}/task/cancel`, { method: 'POST', credentials: 'include', headers: {
                    'content-type': 'application/json', 'x-ploinky-browser-csrf-token': proof.browserMutation.csrfToken }, body: JSON.stringify({ taskId }) });
                if (!stopped.ok) throw new Error('Could not cancel graph generation');
            } catch (error) { onProgress(error.message); }
            finally { await client.close(); }
        })();
        return cancelling;
    };
    const abort = () => { rejectAbort(new Error('Generation cancelled')); void cancelTask(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        signal?.throwIfAborted();
        const pending = client.callTool('roboflow_generate_workflow', { description }, { onTaskUpdate: task => {
            taskId = task.id;
            if (signal?.aborted) void cancelTask();
            else onProgress(task.status);
        } });
        // If cancellation precedes task acknowledgement, keep the transport alive
        // until its id arrives so that the server task can still be cancelled.
        void pending.finally(() => client.close()).catch(() => {});
        const result = await Promise.race([pending, cancelled]);
        if (result.isError) throw new Error(result.content?.map(item => item.text || '').join('\n') || 'Generation failed');
        return JSON.parse(result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
    } finally {
        signal?.removeEventListener('abort', abort);
        if (!signal?.aborted || taskId) await client.close();
    }
}
