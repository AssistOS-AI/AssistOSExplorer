export const INITIAL_SKILL_INSTRUCTIONS = 'Read the SKILL.md headers in .agents/skills and use those skills when needed.';

export const HUMAN_REPORT_INSTRUCTIONS = 'Read and apply .agents/skills/human-report/SKILL.md after every user prompt, including questions, small changes and continuations. Put the entire final response between two identical <<human-report>> markers, each on its own line. Follow the skill for clear, concise language and accurate outcomes. If the workflow requires JSON or routing headings, preserve that required structure inside the markers and write human-facing fields according to the skill.';

export function buildNativePrompt({ prompt, resume = false, selectedSkillName, systemPrompt = '', workflowCatalog }) {
    const parts = [systemPrompt, HUMAN_REPORT_INSTRUCTIONS];
    if (workflowCatalog) parts.push(`Available workflow types (catalog data):\n${JSON.stringify(workflowCatalog)}`);
    if (!resume) parts.push(INITIAL_SKILL_INSTRUCTIONS);
    parts.push(prompt);
    if (selectedSkillName) parts.push(`Use the selected skill at .agents/skills/${selectedSkillName}/SKILL.md.`);
    return parts.filter(Boolean).join('\n\n');
}

export const WORKSPACE_COPILOT_PROMPT = "You are the workspace copilot. Choose and start one workflow for the user's request using launch-workflow. Only when choosing workflow default, also select executionType terminal, desktop or browser. For other workflows their task definitions determine execution modes; do not override them. Do not launch individual robots or control graph traversal. Use the supplied workflow catalog and never invent workflow IDs.";

export function buildWorkflowTaskPrompt({ objective, currentTaskId, graph, previousFinalResponses, continuationPrompt = '', previousSubflowFinalResponse }) {
    return JSON.stringify({
        instruction: 'Execute only the task identified by currentTaskId, following its prompt and the objective. Use previousFinalResponses as context. When supplied, previousSubflowFinalResponse is the final response of the last task in the preceding sub-workflow; inspect the current files before building on that work. Do not execute other graph nodes. Return a final answer, following routing instructions only when supplied.',
        objective, currentTaskId, graph, previousFinalResponses,
        ...(continuationPrompt ? { continuationPrompt } : {}),
        ...(previousSubflowFinalResponse !== undefined ? { previousSubflowFinalResponse } : {}),
    });
}

export function buildTaskPrompt({ task, systemPrompt }) {
    return [systemPrompt, HUMAN_REPORT_INSTRUCTIONS, task].filter(Boolean).join('\n\n');
}

export function routingPrompt(graph, taskId) {
    return `You are a robot executing one task in a directed workflow graph. Execute the current task, then choose exactly one of its outgoing edges. Return Markdown with optional # message and required # nextEdgeId sections. The latter must contain only the edge ID. Do not select incoming edges or edges from another node. Task prompts explain the work at each destination.\nCurrent node: ${taskId}\nComplete graph:\n${JSON.stringify(graph)}\nAllowed outgoing edges:\n${JSON.stringify(graph.edges.filter(edge => edge.sourceTaskId === taskId))}`;
}

// Prepended to the user's description for graph generation; ALA has no separate
// system-instruction option.
export function generationPrompt(catalog) {
    return [
        'You are a workflow planner. For the user task, produce an optimal directed graph: split the task into smaller tasks that each make sense, and find the execution paths that can lead the task to completion. A task can have several possible execution paths, not only a linear one.',
        'Ordinary tasks are executed by a coding agent and must declare exactly one execution type:',
        '- terminal: the usual CLI coding-agent mode;',
        '- desktop: coding agents with computer-use MCP tools operating a virtual desktop;',
        '- browser: coding agents with browser-use MCP tools operating a DuckDuckGo browser, to navigate the web and browse sites.',
        'Return one JSON object with no prose and do not execute the workflow. Fields: name, description, entryTaskId, tasks, edges, layout. Each task has a unique id, name, prompt, skillsets (array of exact catalog IDs; each is a named skillset or an individual skill) and executionType (terminal, desktop or browser). Each edge has a unique id, sourceTaskId, targetTaskId and no description. Write task prompts that let a branching task select its outgoing edge. All endpoints and the entry task must exist. Cycles are allowed. Never choose robots and never generate the reserved default workflow. Layout is optional.',
        `Catalog: ${JSON.stringify(catalog?.skillsets || [])}.`,
        'An ordinary task may set creator:true to choose sequential child workflows. In that case include exactly one shared task {id:"run-workflows",name:"Run workflows",kind:"run-workflows",skillsets:[]}. This managed task has no prompt or executionType, cannot be the entry, accepts edges only from creators and has outgoing continuation edges. Creators may also have ordinary outgoing edges.',
        'Example: {"name":"Report","description":"Produce a report","entryTaskId":"research","tasks":[{"id":"research","name":"Research","prompt":"Open DuckDuckGo and collect sources about the topic","skillsets":[],"executionType":"browser"},{"id":"report","name":"Report","prompt":"Write the report from the collected sources","skillsets":[],"executionType":"terminal"}],"edges":[{"id":"done","sourceTaskId":"research","targetTaskId":"report"}]}',
    ].join('\n');
}

export function creatorPrompt(graph, taskId, catalog) {
    return `You are a workflow creator. Read .agents/skills/workflow-creator/SKILL.md. Choose either an ordinary outgoing edge or the edge into Run workflows to delegate the current task. Choose workflows from the supplied catalog by their descriptions and give each a self-contained prompt. Chosen workflows run sequentially in workflows array order in the same working directory. Put prerequisites before dependent work. Each child starts only after the preceding child completes successfully and receives only that child's last task final response as additional cross-workflow context, not its full history. A failed or stopped child blocks all later children until it is continued or resumed and completes successfully. Give each child a clear scope and instruct it to inspect the current files before making changes. Return one JSON object with message and nextEdgeId. When entering Run workflows, also return afterWorkflowsEdgeId (an outgoing edge of Run workflows) and a nonempty workflows array of {workflowTypeId,prompt}; default additionally requires executionType. Do not launch workflows yourself.\nCurrent node: ${taskId}\nGraph: ${JSON.stringify(graph)}\nAvailable workflows: ${JSON.stringify(catalog)}`;
}
