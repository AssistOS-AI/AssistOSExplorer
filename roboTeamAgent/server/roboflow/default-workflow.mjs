import { DEFAULT_WORKFLOW_ID } from './constants.mjs';

export { DEFAULT_WORKFLOW_ID };

// The default workflow lets the front copilot start one objective on the default
// robot with every execution mode available. Its terminal member is also the
// decision member, so it can decide and, when needed, launch itself again as a
// browser or desktop member.
export function defaultWorkflowDefinition() {
    return {
        id: DEFAULT_WORKFLOW_ID,
        name: 'Default',
        description: 'Run one objective on the default robot with terminal, browser or desktop execution.',
        decisionMemberId: 'default-terminal',
        members: [
            {
                id: 'default-terminal',
                robotName: 'default',
                role: 'Decides the next step and can execute terminal work',
                executionType: 'terminal',
                skillSets: ['copilot'],
                skills: [],
            },
            {
                id: 'default-browser',
                robotName: 'default',
                role: 'Executes browser work',
                executionType: 'browser',
                skillSets: ['copilot'],
                skills: [],
            },
            {
                id: 'default-desktop',
                robotName: 'default',
                role: 'Executes desktop work',
                executionType: 'desktop',
                skillSets: ['copilot'],
                skills: [],
            },
        ],
    };
}

export async function ensureDefaultWorkflow(registry) {
    return registry.ensure(defaultWorkflowDefinition());
}
