---
name: workflow-creator
description: Choose an ordinary workflow edge or delegate the current task to sequential sub-workflows through RoboFlow.
---

# Workflow creator

Read the supplied workflow catalog and choose which workflows solve the current task. Return Markdown fields, each introduced by a separate header with its value on following lines. You may choose an ordinary outgoing edge without delegation using # nextEdgeId and an optional # message. To delegate, choose your edge into Run workflows and also return # afterWorkflowsEdgeId and repeated # workflow blocks. The value of each # workflow is the exact workflow ID from the catalog, followed by # prompt with the child's objective. The default workflow also requires # executionType with terminal, desktop or browser; omit it for other workflows. Use exact IDs from the supplied catalog and graph. afterWorkflowsEdgeId must leave Run workflows.

Write prompts directly as multiline text without JSON escaping or surrounding quotes. If a prompt or message contains reserved field headings, enclose its entire value in a text fence made of backticks or tildes longer than any matching fence inside the value. The outer fence is removed and everything inside stays literal. In one final response, put the plain-language human report first between exactly two human-report markers, then put the technical Markdown after the closing marker. Keep control fields outside the report. Do not repeat the markers in progress messages or draft examples. Do not duplicate the report in # message; use that optional field only for additional task context.

Technical payload example, placed after the human report:

```markdown
# nextEdgeId
creator-to-children
# afterWorkflowsEdgeId
children-to-review
# workflow
default
# executionType
terminal
# prompt
Inspect the current files and implement the assigned scope.
# workflow
default
# executionType
terminal
# prompt
Verify the preceding implementation and report the results.
```

Replace the example edge IDs with actual graph IDs. Select 1 to 100 child workflows. Use the canonical headings above; the parser also accepts variations in capitalization, spacing and heading depth.

RoboFlow executes children sequentially in the order of the workflow blocks in the same folder. Put prerequisite work before dependent work and give each child a self-contained scope. The next child receives only the final response of the last task in the preceding child, alongside its own prompt; it must inspect the current files. A failed child blocks the sequence until explicitly continued and completed successfully. A paused child blocks it until resumed and completed successfully. Later children remain pending. After every child completes successfully, RoboFlow follows afterWorkflowsEdgeId. Children cannot contain creators. Report the plan in your final answer; do not launch workflows through tools.
