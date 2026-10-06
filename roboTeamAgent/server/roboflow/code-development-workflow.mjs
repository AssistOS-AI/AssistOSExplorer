import { requiredDocumentationRepository } from '../required-skills.mjs';
import { normalizeWorkflow } from './graph.mjs';
import { canonicalSkill } from './skill-matching.mjs';

export const CODE_DEVELOPMENT_WORKFLOW_ID = 'code-development';

export function codeDevelopmentWorkflowDefinition(documentationSource = 'DocumentationSkills') {
    const skills = (...names) => names.map(name => canonicalSkill(documentationSource, name));
    return {
        id: CODE_DEVELOPMENT_WORKFLOW_ID,
        name: 'Code Development',
        description: 'Plan a code change, implement it in manageable parts through sequential child workflows, validate the integrated result, revise incomplete work, and report what was implemented.',
        entryTaskId: 'planning',
        tasks: [
            {
                id: 'planning', name: 'Planning', executionType: 'terminal', creator: true, allowsHumanInput: true,
                skillsets: skills('gamp-specs', 'detect-main-behaviors'),
                prompt: 'Read the user objective, repository instructions, relevant existing code and previousFinalResponses. Produce a detailed implementation plan with acceptance criteria, affected files and interfaces, dependencies, ordered implementation steps and a concrete testing strategy. On return from Validation, use its findings to plan the remaining work and preserve completed changes. Delegate implementation through planning-to-subflows using one or more workflows from the supplied catalog. This is your only outgoing edge. Order prerequisite work before dependent implementation, tests and documentation. Each child prompt must include its exact scope, relevant plan context, acceptance criteria, file ownership and appropriate tests. Children run sequentially in array order in the same folder. Each child receives the final response of the preceding workflow and must inspect the files left by earlier children. A failed or paused child blocks later work. Integrated testing belongs to Validation. If using the Standard development workflow (id default), set executionType to terminal. Select subflows-to-validation as afterWorkflowsEdgeId. Return the required creator response with the plan, delegated responsibilities and acceptance criteria for Validation.',
            },
            {
                id: 'validation', name: 'Validation', executionType: 'terminal',
                skillsets: skills('review-specs', 'unslop'),
                prompt: 'Validate the complete implementation against the user objective, the Planning acceptance criteria, the Planning delegation response, and any child workflow outcomes in previousFinalResponses. Inspect the actual working tree and combined changes. Verify that separately implemented parts fit together: interfaces, dependencies, data flow, error handling and user-visible behavior must be coherent and correct. Run appropriate available tests, builds and focused checks, including integration checks rather than relying only on individual child reports. Treat failed children as unresolved work to investigate. If requirements are incomplete, checks fail, or implementation or integration defects remain, select validation-to-planning and report concrete findings, affected files and checks needed for the next iteration. Select validation-to-finish only when the requested implementation is complete and the available checks support that conclusion. Return the required routing response with checks actually run, their results and any limitations. Do not claim success for unverified or incomplete requirements.',
            },
            {
                id: 'finish', name: 'Finish', executionType: 'terminal',
                skillsets: skills('unslop'),
                prompt: 'Report what was implemented for the user objective, using the Planning, child workflow and Validation outcomes in previousFinalResponses. Summarize the delivered behavior, relevant changed files, checks actually run and their results, and any documented limitations. Do not implement additional changes or claim work or verification that did not occur. Return a concise final report to the user.',
            },
            { id: 'run-workflows', name: 'Run workflows', kind: 'run-workflows', skillsets: [] },
        ],
        edges: [
            { id: 'planning-to-subflows', sourceTaskId: 'planning', targetTaskId: 'run-workflows' },
            { id: 'subflows-to-validation', sourceTaskId: 'run-workflows', targetTaskId: 'validation' },
            { id: 'validation-to-planning', sourceTaskId: 'validation', targetTaskId: 'planning', sourcePort: 'right', targetPort: 'left' },
            { id: 'validation-to-finish', sourceTaskId: 'validation', targetTaskId: 'finish' },
        ],
        layout: {
            planning: { x: 60, y: 60 }, 'run-workflows': { x: 320, y: 230 },
            validation: { x: 580, y: 60 }, finish: { x: 840, y: 60 },
        },
    };
}

export async function ensureCodeDevelopmentWorkflow(registry, skillService = {}) {
    const definition = codeDevelopmentWorkflowDefinition(await requiredDocumentationRepository(skillService));
    await registry.ensure(definition, { builtin: false, system: true });
    // Synchronize the protected preset; run snapshots keep their original graph.
    const expected = normalizeWorkflow(definition);
    return registry.database.transaction(() => {
        const current = registry.getSync(CODE_DEVELOPMENT_WORKFLOW_ID);
        const changed = Object.keys(expected).some(key => JSON.stringify(current[key]) !== JSON.stringify(expected[key]));
        if (!changed) return current;
        const updated = { ...current, ...expected,
            revision: current.revision + 1, updatedAt: new Date().toISOString(),
        };
        registry.database.db.prepare('UPDATE workflow_types SET record=? WHERE id=?').run(JSON.stringify(updated), updated.id);
        return updated;
    });
}
