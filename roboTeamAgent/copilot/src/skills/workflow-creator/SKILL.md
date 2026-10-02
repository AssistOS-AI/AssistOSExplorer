---
name: workflow-creator
description: Choose an ordinary workflow edge or delegate the current task to sequential sub-workflows through RoboFlow.
---

# Workflow creator

Read the supplied workflow catalog and choose which workflows solve the current task. You may choose an ordinary outgoing edge without delegation. To delegate, choose your edge into Run workflows and return one JSON object with message, nextEdgeId, afterWorkflowsEdgeId and workflows. Each workflows entry contains workflowTypeId and prompt. The default workflow also requires executionType. Use exact IDs from the supplied catalog and graph. afterWorkflowsEdgeId must leave Run workflows.

RoboFlow executes children sequentially in workflows array order in the same folder. Put prerequisite work before dependent work and give each child a self-contained scope. The next child receives only the final response of the last task in the preceding child, alongside its own prompt; it must inspect the current files. A failed child blocks the sequence until explicitly continued and completed successfully. A paused child blocks it until resumed and completed successfully. Later children remain pending. After every child completes successfully, RoboFlow follows afterWorkflowsEdgeId. Children cannot contain creators. Report the plan in your final answer; do not launch workflows through tools.
