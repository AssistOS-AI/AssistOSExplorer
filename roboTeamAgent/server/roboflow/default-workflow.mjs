export const DEFAULT_WORKFLOW_ID = 'default';
export function defaultWorkflowDefinition() {
    return { id: DEFAULT_WORKFLOW_ID, name: 'Default', description: 'Execute the objective on the default robot in the selected terminal, desktop or browser mode.',
        entryTaskId: 'execute', tasks: [{ id: 'execute', name: 'Execute objective', prompt: 'Execute the supplied objective and return the final result.',
            skillsets: ['builtin:copilot/copilot'], supportedExecutionTypes: ['terminal', 'desktop', 'browser'] }], edges: [] };
}
export async function ensureDefaultWorkflow(registry) { return registry.ensure(defaultWorkflowDefinition()); }
