const MAX_BYTES = 512 * 1024;
const ID = /^[A-Za-z0-9_-]{22}$/u;
const REFERENCE = /^[A-Za-z0-9_-]{22,64}$/u;

// Project workspace-global discovery only. Prompts, objectives, source paths, graph and robot details stay in RoboTeam.
export function projectWorkflowCatalog(workflows) {
    const result = { ok: true, workflows: workflows.map((workflow) => ({
        id: workflow.id, name: workflow.name, description: workflow.description || '',
        ...(workflow.kind === 'default' ? { kind: 'default' } : {}),
        hasDefaultObjective: Boolean(workflow.defaultObjective),
        tasks: (workflow.tasks || []).map((task) => ({ name: task.name,
            ...(['terminal', 'desktop', 'browser'].includes(task.executionType) ? { executionType: task.executionType } : {}),
        })),
    })) };
    return Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES ? { ok: false, error: 'catalog_too_large' } : result;
}

// One fresh read per pending request, with no cache or coalescing. A stopped bridge never sends a late reply.
export function createWorkflowCatalogBridge({ roboflow, hop, pollMs = 500, timers = { setTimeout, clearTimeout } }) {
    let closed = false;
    let running = null;
    let timer = null;
    async function poll() {
        const outcome = await hop.call('workflow-catalog/requests', {});
        if (closed || outcome?.outcome !== 'response' || outcome.status !== 200 || outcome.refusal) return;
        const requests = outcome.json?.requests;
        if (!Array.isArray(requests) || requests.length > 16 || requests.some((request) => !request
            || Object.keys(request).sort().join(',') !== 'attemptId,referenceId,requestId'
            || !REFERENCE.test(request.referenceId) || !ID.test(request.attemptId) || !ID.test(request.requestId))) return;
        for (const request of requests) {
            if (closed) return;
            let result;
            try { result = projectWorkflowCatalog(await roboflow.listWorkflows()); }
            catch { result = { ok: false, error: 'catalog_unavailable' }; }
            if (closed) return;
            await hop.call(`references/${request.referenceId}/workflow-catalog/reply`, {
                attemptId: request.attemptId, requestId: request.requestId, result,
            });
        }
    }
    async function tick() {
        if (closed || running) return running;
        running = poll().catch(() => {}).finally(() => {
            running = null;
            if (!closed) {
                timer = timers.setTimeout(tick, pollMs);
                timer.unref?.();
            }
        });
        return running;
    }
    return Object.freeze({
        start() { if (!closed && timer === null && running === null) void tick(); },
        async close() {
            closed = true;
            timers.clearTimeout(timer);
            await running;
        },
    });
}
