import { extractJson, parseRoute } from './result-parser.mjs';
import { hasCreators, isCoordinator, invalid, textField, workflowCatalogEntry } from './graph.mjs';
import { EXECUTION_TYPES } from './constants.mjs';

const stopped = state => ['stopped', 'interrupted'].includes(state);
const finished = state => ['completed', 'failed'].includes(state);
export const CONTINUE_PROMPT = 'Continuă de unde ai rămas';

export class Subflows {
    constructor(service) { this.service = service; }
    async catalog() {
        return (await this.service.registry.list()).filter(graph => !hasCreators(graph) && !graph.tasks.some(isCoordinator))
            .map(graph => { const { tasks, ...entry } = workflowCatalogEntry(graph); return entry; });
    }
    async plan(flow, instance, output) {
        const { edge } = parseRoute(output, flow.graph, instance.taskId);
        if (!isCoordinator(flow.graph.tasks.find(task => task.id === edge.targetTaskId))) return { edge };
        if (flow.parentFlowId) throw invalid('Sub-workflows cannot delegate workflows');
        const response = extractJson(output);
        const after = flow.graph.edges.find(item => item.id === response.afterWorkflowsEdgeId && item.sourceTaskId === edge.targetTaskId);
        if (!after) throw invalid('afterWorkflowsEdgeId must leave Run workflows');
        if (!Array.isArray(response.workflows) || response.workflows.length < 1 || response.workflows.length > 100) throw invalid('Creator must choose 1 to 100 workflows');
        const plans = [];
        for (const item of response.workflows) {
            if (!item || typeof item.workflowTypeId !== 'string') throw invalid('workflowTypeId is required');
            const graph = await this.service.registry.get(item.workflowTypeId);
            if (!graph || hasCreators(graph) || graph.tasks.some(isCoordinator)) throw invalid('Child workflow must exist and contain no creators');
            if (graph.kind === 'default' ? !EXECUTION_TYPES.includes(item.executionType) : item.executionType !== undefined) throw invalid('executionType is required only for default child workflows');
            plans.push({ graph, objective: textField(item.prompt, 'child prompt', 32768, true),
                ...(graph.kind === 'default' ? { executionType: item.executionType } : {}) });
        }
        return { edge, afterEdgeId: after.id, plans };
    }
    // Called inside the parent transaction: child IDs and their graph snapshots commit together.
    createChildren(flow, creator, coordinator, plan) {
        const { store } = this.service;
        coordinator.creatorInstanceId = creator.id;
        coordinator.afterEdgeId = plan.afterEdgeId;
        let previousChildFlowId = null;
        coordinator.childFlowIds = plan.plans.map(({ graph, ...input }) => {
            const child = store.createRecord(graph, { ...input, folder: flow.folder, createdBy: flow.createdBy,
                parentFlowId: flow.id, parentInstanceId: coordinator.id, creatorInstanceId: creator.id });
            child.previousChildFlowId = previousChildFlowId;
            child.status = 'pending'; child.activeSince = null;
            store.saveSync(child);
            previousChildFlowId = child.id;
            return child.id;
        });
        creator.childFlowIds = coordinator.childFlowIds;
    }
    async dispatch(flow, instance) {
        if (!instance.childFlowIds?.length) throw invalid('Run workflows has no creator plan');
        await this.service.store.update(flow.id, current => {
            const visit = current.instances.find(item => item.id === instance.id);
            visit.state = 'running'; visit.startedAt ||= new Date().toISOString();
        });
        await this.reconcile(flow.id);
    }
    async reconcile(id) {
        const { store } = this.service;
        let flow = await store.get(id);
        if (!flow || flow.stopRequested) return;
        for (const visit of flow.instances.filter(item => item.childFlowIds?.length && item.creatorInstanceId && item.state !== 'completed')) {
            let children = await Promise.all(visit.childFlowIds.map(child => store.get(child)));
            if (children.some(child => !child)) throw new Error('Child workflow record is unavailable');
            const next = children.find(child => child.status !== 'completed');
            if (next?.status === 'pending') {
                await this.service._serialize(next.id, async () => {
                    const child = await store.get(next.id);
                    if (child.status !== 'pending') return;
                    await store.update(child.id, current => {
                        const first = this.service._instance(current.graph.entryTaskId, 0);
                        current.instances.push(first); current.currentInstanceId = first.id;
                        current.status = 'running'; current.error = null; current.finishedAt = null;
                    });
                    await this.service._dispatch(child.id);
                });
                children = await Promise.all(visit.childFlowIds.map(child => store.get(child)));
            }
            if (children.every(child => child.status === 'completed')) {
                const outcomes = children.map(child => ({ flowId: child.id, workflowTypeId: child.workflowTypeId,
                    status: child.status, error: child.error }));
                await store.writeOutput(id, visit.id, JSON.stringify(outcomes), 'result');
                const edge = flow.graph.edges.find(item => item.id === visit.afterEdgeId && item.sourceTaskId === visit.taskId);
                if (!edge) throw invalid('Saved continuation edge is unavailable');
                await this.service._advance(id, visit.id, edge);
            } else {
                const active = children.some(child => ['queued', 'starting', 'running', 'stopping'].includes(child.status));
                const failed = children.find(child => child.status === 'failed');
                const state = active ? 'running' : children.some(child => stopped(child.status)) ? 'stopped' : failed ? 'failed' : 'running';
                const error = state === 'failed' ? `Sub-workflow ${failed.id} failed: ${failed.error || 'Execution failed'}` : null;
                if (visit.state !== state || visit.error !== error) await store.update(id, current => {
                    const phase = current.instances.find(item => item.id === visit.id);
                    phase.state = state; phase.error = error;
                    phase.endedAt = state === 'running' ? null : new Date().toISOString();
                    this.service._derive(current);
                    if (current.status === 'failed') current.error = error;
                });
            }
            flow = await store.get(id);
        }
    }
    async results(ids) {
        return Promise.all(ids.map(async id => {
            const child = await this.service.getFlow(id);
            return { flowId: child.id, workflowTypeId: child.workflowTypeId, status: child.status,
                error: child.error, result: child.result || '' };
        }));
    }
    async stopChildren(flow) {
        const ids = flow.instances.filter(item => item.creatorInstanceId).flatMap(item => item.childFlowIds || []);
        await Promise.all(ids.map(async id => {
            const child = await this.service.store.get(id);
            if (child && child.status !== 'pending' && !finished(child.status)) await this.service.stopFlow(id);
        }));
    }
    async resumeChildren(flow) {
        const ids = [];
        for (const visit of flow.instances.filter(item => item.creatorInstanceId && stopped(item.state))) {
            for (const id of visit.childFlowIds || []) {
                const child = await this.service.store.get(id);
                if (child?.status === 'completed') continue;
                if (child && stopped(child.status)) ids.push(id);
                break;
            }
        }
        const results = await Promise.allSettled(ids.map(async id => {
            const child = await this.service.store.get(id);
            if (child && stopped(child.status)) await this.service.resumeFlow(id);
        }));
        const errors = results.filter(item => item.status === 'rejected').map(item => item.reason.message);
        if (errors.length) throw new Error(errors.join('; '));
    }
    async assertCanContinue(flow) {
        if (!flow.parentFlowId) return;
        const parent = await this.service.store.get(flow.parentFlowId);
        if (!parent || parent.stopRequested) throw invalid('Resume the parent workflow before continuing this child');
        // Previously dispatched parallel children cannot acquire a new execution order retroactively.
        if (!Object.hasOwn(flow, 'previousChildFlowId')) return;
        const visit = parent.instances.find(item => item.id === flow.parentInstanceId);
        const ids = visit?.childFlowIds || [];
        const index = ids.indexOf(flow.id);
        if (index < 0) throw invalid('Child workflow is not in its parent sequence');
        for (const id of ids.slice(0, index)) {
            if ((await this.service.store.get(id))?.status !== 'completed') throw invalid('Complete the preceding sub-workflow first');
        }
        for (const id of ids.slice(index + 1)) {
            if ((await this.service.store.get(id))?.status !== 'pending') throw invalid('A later sub-workflow has already started');
        }
    }
}
