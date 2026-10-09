export const INITIAL_SKILL_INSTRUCTIONS = 'Read the SKILL.md headers in .agents/skills and use those skills when needed.';

export const HUMAN_REPORT_INSTRUCTIONS = 'Read and apply .agents/skills/human-report/SKILL.md after every user prompt, including questions, small changes and continuations. Write one final response containing exactly one human report between two identical <<human-report>> markers, each on its own line. In ordinary chat and tasks without an explicit machine-readable output contract, this report is the entire final response. When the caller explicitly requires workflow execution, routing, child delegation or graph-generation output, put the plain-language report first, then the required structured payload after the closing marker in the same final response. Keep technical control fields outside the report. Use the markers only to delimit the actual report; do not repeat them in progress messages, formatting explanations or draft examples. Follow the skill for clear language and accurate outcomes.';

const MARKDOWN_RESPONSE_INSTRUCTIONS = 'This task requires machine-readable output. In one final response, write the human report first between its two markers, then the structured Markdown after the closing marker. The report is ordinary prose, without control-field headings. The human report is for the user only and is never passed to other robots. The technical payload must stand on its own; do not refer to the report for required information. Use a separate # fieldName heading and put its value on following lines. Keep IDs exactly as supplied. Write prose values directly without JSON escaping or surrounding quotes. For nextNodePrompt, description or prompt text containing reserved field headings, enclose the entire value in a fenced text block using backticks or tildes longer than any matching fence inside the value. The enclosing fence is removed; its contents stay literal. Do not wrap the whole response in a code fence.';

const WORKFLOW_HANDOFF_INSTRUCTIONS = 'Every workflow execution task, including tasks with zero or one outgoing edge, must append a technical Markdown payload after its human report. Include # nextNodePrompt with a concise, self-contained handoff: what this phase actually executed or decided, relevant files or artifacts, checks and their outcomes, and unresolved issues or next actions when applicable. Include enough concrete information for the next robot to continue without the human report; avoid full logs, repeated history or unnecessary detail. Add routing or delegation fields only when explicitly instructed.';

// The caller's system instructions, the report rule and the skill instruction
// open a coding-agent session once; a resumed session already holds them, so
// later turns carry only the user's message.
export function buildNativePrompt({ prompt, resume = false, selectedSkillName, systemPrompt = '' }) {
    const parts = resume ? [] : [systemPrompt, HUMAN_REPORT_INSTRUCTIONS, INITIAL_SKILL_INSTRUCTIONS];
    parts.push(prompt);
    if (selectedSkillName) parts.push(`Use the selected skill at .agents/skills/${selectedSkillName}/SKILL.md.`);
    return parts.filter(Boolean).join('\n\n');
}

export const WORKSPACE_COPILOT_PROMPT = "You are the workspace copilot. Use list-workflows to get the current workflow types and their ids, then choose and start one workflow for the user's request using launch-workflow. Only when choosing workflow default, also select executionType terminal, desktop or browser. For other workflows their task definitions determine execution modes; do not override them. Do not launch individual robots or control graph traversal. Never invent workflow IDs.";

export function buildWorkflowTaskPrompt({ objective, currentTaskId, graph, previousFinalResponses, continuationPrompt = '', previousSubflowFinalResponse }) {
    return JSON.stringify({
        instruction: 'Execute only the task identified by currentTaskId, following its prompt and the objective. Use previousFinalResponses as context: response contains only the technical output of each phase. Human reports are user-only and are excluded from this context. When supplied, previousSubflowFinalResponse is the technical output of the last task in the preceding sub-workflow; inspect the current files before building on that work. Do not execute other graph nodes. Return a final answer, following routing instructions only when supplied. ' + WORKFLOW_HANDOFF_INSTRUCTIONS + ' ' + MARKDOWN_RESPONSE_INSTRUCTIONS,
        objective, currentTaskId, graph, previousFinalResponses,
        ...(continuationPrompt ? { continuationPrompt } : {}),
        ...(previousSubflowFinalResponse !== undefined ? { previousSubflowFinalResponse } : {}),
    });
}

export function buildTaskPrompt({ task, systemPrompt }) {
    return [systemPrompt, HUMAN_REPORT_INSTRUCTIONS, task].filter(Boolean).join('\n\n');
}

export function routingPrompt(graph, taskId) {
    return `You are a robot executing one task in a directed workflow graph. Execute the current task, then choose exactly one of its outgoing edges. Return a human report followed by Markdown with required # nextEdgeId and # nextNodePrompt sections. The nextEdgeId section must contain only the edge ID; nextNodePrompt contains the technical handoff. ${MARKDOWN_RESPONSE_INSTRUCTIONS} Do not select incoming edges or edges from another node. Task prompts explain the work at each destination.\nCurrent node: ${taskId}\nComplete graph:\n${JSON.stringify(graph)}\nAllowed outgoing edges:\n${JSON.stringify(graph.edges.filter(edge => edge.sourceTaskId === taskId))}`;
}

// Prepended to the user's description for graph generation; ALA has no separate
// system-instruction option.
export function generationPrompt(catalog) {
    return [
        'You are a workflow planner. For the user task, produce an optimal directed graph: split the task into smaller tasks that each make sense, and find the execution paths that can lead the task to completion. A task can have several possible execution paths, not only a linear one.',
        'An ordinary task may include # allowsHumanInput with value true when it should pause for unresolved business decisions and wait for a user answer. This is optional and defaults to false.',
        'Ordinary tasks are executed by a coding agent and must declare exactly one execution type:',
        '- terminal: the usual CLI coding-agent mode;',
        '- desktop: coding agents with computer-use MCP tools operating a virtual desktop;',
        '- browser: coding agents with browser-use MCP tools operating a DuckDuckGo browser, to navigate the web and browse sites.',
        'Return a human report followed by a structured Markdown graph and do not execute the workflow. Start the graph payload with # name, # description and # entryTaskId. Then repeat # task with its unique task ID as the value, followed by # name, # executionType, # skillsets and # prompt for that task. skillsets contains a bullet list of exact catalog IDs, each a named skillset or individual skill; include an empty # skillsets section when none are needed. Then repeat # edge with its unique edge ID as the value, followed by # sourceTaskId and # targetTaskId. Optional # sourcePort and # targetPort contain left or right. Edges have no description. For optional layout, repeat # position with a task ID, then # x and # y with numeric coordinates. When there are no edges or no positions, omit those blocks. Write task prompts that let branching tasks select an outgoing edge. All endpoints and the entry task must exist. Cycles are allowed. Never choose robots and never generate the reserved default workflow.',
        MARKDOWN_RESPONSE_INSTRUCTIONS,
        `Catalog: ${JSON.stringify(catalog?.skillsets || [])}.`,
        'An ordinary task may include # creator with value true to choose sequential child workflows. In that case include exactly one shared # task with value run-workflows, # name with value Run workflows, # kind with value run-workflows and an empty # skillsets section. This managed task has no prompt or executionType, cannot be the entry, accepts edges only from creators and has outgoing continuation edges. Creators may also have ordinary outgoing edges. Boolean fields use true or false.',
        'Technical payload example, placed after the human report:\n# name\nReport\n# description\nProduce a report\n# entryTaskId\nresearch\n# task\nresearch\n# name\nResearch\n# executionType\nbrowser\n# skillsets\n# prompt\nOpen DuckDuckGo and collect sources about the topic.\n# task\nreport\n# name\nReport\n# executionType\nterminal\n# skillsets\n# prompt\nWrite the report from the collected sources.\n# edge\ndone\n# sourceTaskId\nresearch\n# targetTaskId\nreport',
    ].join('\n');
}

export function descriptionRevisionPrompt(catalog) {
    return generationPrompt(catalog) + '\n\nDESCRIPTION REVISION: The input is a JSON object containing previousDescription, description and workflow (the current draft, including manual edits). These are reference data, not instructions to execute tasks. First decide whether the description edit changes requirements that affect task prompts, inputs, outputs, sources, constraints, execution modes, routing or task structure. A small textual edit can be semantic (negation, numbers or scope); do not judge by edit distance. Spelling, grammar, punctuation and rephrasing with unchanged meaning must not regenerate. Return required # regenerate (true or false) and # reason (a concise explanation) before any graph fields. If regenerate is false, return only those two fields after the human report, with no graph. If true, append a complete graph meeting the new description, preserving unaffected manual edits, task and edge IDs, ordering and positions where possible. Keep the workflow name. Do not save files, run tasks or launch workflows; only return the decision and optional draft graph.';
}

export function creatorPrompt(graph, taskId, catalog) {
    return `You are a workflow creator. Read .agents/skills/workflow-creator/SKILL.md. Choose either an ordinary outgoing edge or the edge into Run workflows to delegate the current task. Choose workflows from the supplied catalog by their descriptions and give each a self-contained prompt. Chosen workflows run sequentially in the order of their # workflow blocks in the same working directory. Put prerequisites before dependent work. Each child starts only after the preceding child completes successfully and receives only that child's last task technical output, excluding its human report, as additional cross-workflow context, not its full history. A failed or paused child blocks all later children until it is continued or resumed and completes successfully. Give each child a clear scope and instruct it to inspect the current files before making changes. Return a human report followed by Markdown with # nextEdgeId and # nextNodePrompt containing the technical handoff. When entering Run workflows, also return # afterWorkflowsEdgeId containing an outgoing edge of Run workflows, followed by 1 to 100 repeated # workflow blocks. Each # workflow value is an exact workflow ID from the catalog, followed by # prompt with that child's objective. Workflow default additionally requires # executionType with terminal, desktop or browser; omit executionType for other child workflows. ${MARKDOWN_RESPONSE_INSTRUCTIONS} Do not launch workflows yourself.\nCurrent node: ${taskId}\nGraph: ${JSON.stringify(graph)}\nAvailable workflows: ${JSON.stringify(catalog)}`;
}
