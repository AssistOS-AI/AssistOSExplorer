---
name: bash
description: Execute command text or a JSON command as bounded argv inside the native workspace sandbox, without shell interpretation.
---

# Bash

## Summary
Execute a command inside ALA's existing native workspace sandbox.

## Description
Use this when the user asks to run a command. The skill parses the executable and arguments, expands globs, and delegates execution to the SDK in the same sandbox. Native backend policy and `/permissions` govern approval of script execution; this skill does not add an approval cache or a second supervisor.

## Help
Input: command text exactly as it should be run, or JSON with `command`.

## Input Format
Plain text command:

```
ls -la /tmp
grep -r "pattern" src/
find . -name "*.js"
rm unwanted-file.txt
git status
```

Example:
bash git status

JSON command:

```json
{"command":"git status"}
```

## Output Format
Returns stdout text. Non-zero exit, timeout, execution denial, or other execution errors produce a readable status message.

## Constraints
- The skill contains no approval prompts, risk classifier, allowlist, or denial memory.
- Commands execute without a shell; pipes, redirections, and shell operators are not interpreted.
- Glob expansion is applied before the structured command is sent to the local executor.
- The local executor is mandatory and fails closed when unavailable.
- `/permissions` selects native backend policy, not a Bash-only approval system.

## Execution

Run `node <skill-directory>/scripts/run.mjs --input 'git status'` from the workspace. JSON command input is accepted through the same string argument. The wrapper imports its local `scripts/ploinkyInvocation.mjs`, creates a `bash` invocation, awaits `scripts/action.mjs`, prints text or JSON, and closes the invocation. Missing or expired SDK access fail explicitly.

`scripts/parser.mjs` owns quote and escape tokenization; `scripts/globExpander.mjs` owns deterministic sorted expansion and leaves unmatched patterns intact. Helpers stay in this skill directory. The SDK executes argv locally within the sandbox with bounded output and timeout; it never forwards a shell command to the parent process.
