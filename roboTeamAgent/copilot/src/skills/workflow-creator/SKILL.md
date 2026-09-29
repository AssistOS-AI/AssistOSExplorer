---
name: workflow-creator
description: Choose an ordinary workflow edge or delegate the current task to parallel sub-workflows through RoboFlow.
---

# Workflow creator

Read the supplied workflow catalog and choose which workflows solve the current task. You may choose an ordinary outgoing edge without delegation. To delegate, choose your edge into Run workflows and return one JSON object with message, nextEdgeId, afterWorkflowsEdgeId and workflows. Each workflows entry contains workflowTypeId and prompt. The default workflow also requires executionType. Use exact IDs from the supplied catalog and graph. afterWorkflowsEdgeId must leave Run workflows.

RoboFlow starts all children in parallel, waits for them, and follows afterWorkflowsEdgeId. Children cannot contain creators. Supply independent, self-contained prompts; array order does not impose execution order. Report the plan in your final answer; do not launch workflows through tools. A failed child counts as finished; a stopped child blocks the join until resumed.
