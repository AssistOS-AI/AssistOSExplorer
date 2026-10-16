---
name: report-task-blocked
description: Fail the executing workflow phase when missing resources, access, tools or capabilities prevent completing the request according to its requirements and agreed plan.
---

# Report task blocked

Use this skill when you determine that you cannot complete the request correctly with the available resources, access, tools or capabilities. Check the available context first. Prefer reporting the blocker to producing an incorrect result or claiming success.

Follow the agreed plan and established procedure. If an established path is inaccessible, do not substitute an unrelated workaround, weaken validation, change the requested outcome or perform out-of-scope work just to finish. Explain the blocker instead. Resolve routine technical choices yourself; this skill is for an actual inability to fulfill the request.

Run this script from the skill directory with one JSON argument:

```sh
node scripts/run.mjs --input '{"message":"Stopped at deployment: the required deployment credentials are unavailable. The build passed validation but has not been deployed."}'
```

The message must explain exactly where work stopped and why. Include relevant completed work and what is needed to continue. Do not include credentials or secrets. Use proper shell quoting.

This skill is provided only during workflow execution. The script fails the executing phase and terminates its ALA process. The workflow retains its existing status priority rules. The script may be interrupted by termination before printing its acknowledgement. Do not continue working or claim success after invoking it. If delivery fails, report that failure without attempting an unauthorized alternative.
