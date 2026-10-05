---
name: list-workflows
description: List the RoboFlow workflow types defined in the workspace, with their descriptions, tasks and execution modes. Use when the user asks which workflows exist, or before starting a workflow with launch-workflow.
---

# List Workflows

## Description
Returns the current workspace workflow types from RoboFlow. Each line gives the workflow id, its name, its description and its tasks with their execution types. A workflow whose tasks support several execution modes says which `executionType` values can be chosen when it is started. The list is read from RoboFlow on every call, so it includes workflows created or changed since the conversation began.

## Input Format
No input is needed. Run `scripts/run.mjs` with no arguments, or with an empty `--input ""`.

## Output Format
One line per workflow type: `- <id> — <name> — <description> Tasks: <task (execution type)>, ...`. When no workflow is defined, the result says so.

## Constraints
- Only reads the list; it never starts, changes or deletes a workflow.
- Use the ids exactly as listed when calling launch-workflow; never invent an id.
- Answer the user's question from this list when they ask what workflows exist; do not start a workflow unless they ask for work.
