import { requiredDocumentationRepository } from '../required-skills.mjs';
import { canonicalSkill } from './skill-matching.mjs';

export const CODE_DEVELOPMENT_WORKFLOW_ID = 'code-development';

export function codeDevelopmentWorkflowDefinition(documentationSource = 'DocumentationSkills') {
    const skills = (...names) => names.map(name => canonicalSkill(documentationSource, name));
    return {
        id: CODE_DEVELOPMENT_WORKFLOW_ID,
        name: 'Code Development',
        description: 'Plan a code change, implement it in manageable parts through sequential child workflows, then validate the integrated result against the user request.',
        entryTaskId: 'planning',
        tasks: [
            {
                id: 'planning', name: 'Planning', executionType: 'terminal',
                skillsets: skills('gamp-specs', 'detect-main-behaviors'),
                prompt: 'Read the user objective, repository instructions and relevant existing code. Produce a detailed implementation plan with acceptance criteria, affected files and interfaces, dependencies, ordered implementation steps, and a concrete testing strategy. Order prerequisites before dependent implementation, tests and documentation. Identify integration risks and how to validate the assembled result. Do not implement the changes in this phase. Return a self-contained plan for Execution and Validation.',
            },
            {
                id: 'execution', name: 'Execution', executionType: 'terminal', creator: true,
                skillsets: skills('node-coding-style', 'web-design', 'gamp-specs', 'detect-main-behaviors', 'unslop'),
                prompt: 'Implement the Planning phase plan for the user objective in manageable parts; do not attempt the entire change in one undifferentiated step. Read the plan from previousFinalResponses and inspect the working tree. Delegate implementation parts through execution-to-subflows using one or more workflows from the supplied catalog. This is your only outgoing edge. Split the plan into ordered child workflows, placing prerequisite work before dependent implementation, tests and documentation. Each child prompt must include its exact scope, relevant plan context, acceptance criteria, file ownership and appropriate tests. Children run sequentially in array order in the same folder. Each child starts only after its predecessor completes successfully and receives the final response of the last task in that preceding workflow. A failed or stopped child blocks later work. Each child must inspect the files left by earlier children. Testing may be a later child task; integrated testing belongs to Validation. If using the default workflow, set executionType to terminal. For delegation select subflows-to-validation as afterWorkflowsEdgeId. Return the required creator response, describing completed work, delegated responsibilities and any limitations for Validation.',
            },
            {
                id: 'validation', name: 'Validation', executionType: 'terminal',
                skillsets: skills('review-specs', 'unslop'),
                prompt: 'Validate the complete implementation against the user objective, the Planning acceptance criteria, the Execution response, and any child workflow outcomes in previousFinalResponses. Inspect the actual working tree and combined changes. Verify that separately implemented parts fit together: interfaces, dependencies, data flow, error handling and user-visible behavior must be coherent and correct. Run appropriate available tests, builds and focused checks, including integration checks rather than relying only on individual child reports. Treat failed children as unresolved work to investigate. Fix concrete implementation or integration defects within the requested scope and repeat the affected checks. Return a clear final report of what was delivered, checks actually run and their results, and any remaining gaps or blockers. Do not claim success for unverified or incomplete requirements.',
            },
            { id: 'run-workflows', name: 'Run workflows', kind: 'run-workflows', skillsets: [] },
        ],
        edges: [
            { id: 'planning-to-execution', sourceTaskId: 'planning', targetTaskId: 'execution' },
            { id: 'execution-to-subflows', sourceTaskId: 'execution', targetTaskId: 'run-workflows' },
            { id: 'subflows-to-validation', sourceTaskId: 'run-workflows', targetTaskId: 'validation' },
        ],
        layout: {
            planning: { x: 60, y: 60 }, execution: { x: 320, y: 60 },
            validation: { x: 840, y: 60 }, 'run-workflows': { x: 580, y: 230 },
        },
    };
}

export async function ensureCodeDevelopmentWorkflow(registry, skillService = {}) {
    const definition = codeDevelopmentWorkflowDefinition(await requiredDocumentationRepository(skillService));
    await registry.ensure(definition, { builtin: false, system: true });
    // Upgrade the saved preset once; run snapshots keep their original graph.
    return registry.database.transaction(() => {
        const current = registry.getSync(CODE_DEVELOPMENT_WORKFLOW_ID);
        const routingChanged = current.edges.some(edge => edge.sourceTaskId === 'execution' && edge.targetTaskId === 'validation');
        const requirements = new Map(definition.tasks.map(task => [task.id, task.skillsets]));
        const skillsChanged = current.tasks.some(task => requirements.has(task.id)
            && JSON.stringify(task.skillsets) !== JSON.stringify(requirements.get(task.id)));
        const promptsChanged = current.description !== definition.description || current.tasks.some(task => {
            const expected = definition.tasks.find(item => item.id === task.id);
            return expected && task.prompt !== expected.prompt;
        });
        if (!routingChanged && !skillsChanged && !promptsChanged) return current;
        const updated = { ...current,
            description: definition.description,
            tasks: current.tasks.map(task => ({ ...task,
                ...(requirements.has(task.id) ? { skillsets: requirements.get(task.id) } : {}),
                ...(definition.tasks.find(item => item.id === task.id)?.prompt
                    ? { prompt: definition.tasks.find(item => item.id === task.id).prompt } : {}),
            })),
            edges: current.edges.filter(edge => !(edge.sourceTaskId === 'execution' && edge.targetTaskId === 'validation')),
            revision: current.revision + 1, updatedAt: new Date().toISOString(),
        };
        registry.database.db.prepare('UPDATE workflow_types SET record=? WHERE id=?').run(JSON.stringify(updated), updated.id);
        return updated;
    });
}
