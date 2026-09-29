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
        coordinator.childFlowIds = plan.plans.map(({ graph, ...input }) => {
            const child = store.createRecord(graph, { ...input, folder: flow.folder, createdBy: flow.createdBy,
                parentFlowId: flow.id, parentInstanceId: coordinator.id, creatorInstanceId: creator.id });
            const first = this.service._instance(graph.entryTaskId, 0);
            child.instances.push(first); child.currentInstanceId = first.id;
            store.saveSync(child);
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
        await Promise.all(instance.childFlowIds.map(id => this.service._serialize(id, () => this.service._dispatch(id))));
        await this.reconcile(flow.id);
    }
    async reconcile(id) {
        const { store } = this.service;
        let flow = await store.get(id);
        if (!flow || flow.stopRequested) return;
        for (const visit of flow.instances.filter(item => item.childFlowIds?.length && item.creatorInstanceId && item.state !== 'completed' && item.state !== 'failed')) {
            const children = await Promise.all(visit.childFlowIds.map(child => store.get(child)));
            if (children.some(child => !child)) throw new Error('Child workflow record is unavailable');
            if (children.every(child => finished(child.status))) {
                const outcomes = children.map(child => ({ flowId: child.id, workflowTypeId: child.workflowTypeId,
                    status: child.status, error: child.error }));
                await store.writeOutput(id, visit.id, JSON.stringify(outcomes), 'result');
                const edge = flow.graph.edges.find(item => item.id === visit.afterEdgeId && item.sourceTaskId === visit.taskId);
                if (!edge) throw invalid('Saved continuation edge is unavailable');
                await this.service._advance(id, visit.id, edge);
            } else {
                const state = children.some(child => !finished(child.status) && !stopped(child.status)) ? 'running' : 'stopped';
                if (visit.state !== state) await store.update(id, current => {
                    const phase = current.instances.find(item => item.id === visit.id);
                    phase.state = state; phase.error = null;
                    phase.endedAt = state === 'stopped' ? new Date().toISOString() : null;
                    this.service._derive(current);
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
            if (child && !finished(child.status)) await this.service.stopFlow(id);
        }));
    }
    async resumeChildren(flow) {
        const ids = flow.instances.filter(item => item.creatorInstanceId && stopped(item.state)).flatMap(item => item.childFlowIds || []);
        const results = await Promise.allSettled(ids.map(async id => {
            const child = await this.service.store.get(id);
            if (child && stopped(child.status)) await this.service.resumeFlow(id);
        }));
        const errors = results.filter(item => item.status === 'rejected').map(item => item.reason.message);
        if (errors.length) throw new Error(errors.join('; '));
    }
}
