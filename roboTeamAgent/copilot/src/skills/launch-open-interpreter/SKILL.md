---
name: launch-open-interpreter
description: Delegate an execution-oriented task to Open Interpreter through the authenticated Copilot Provider Relay, forwarding safe workspace context.
---

# Launch Open Interpreter

Dispatch an execution-oriented Copilot task to the Open Interpreter provider
through the Copilot Provider Relay.

## Backend
open-interpreter

## Cacheable
false

## RequiresInvocationCapability
true

## ProviderAvailability
active

## Input Format
Accepts a JSON object or plain prompt text.

Fields:
- `prompt` (string): natural-language execution task.
- `workingDir` is supplied by the runtime; JSON input cannot replace the workspace.
- `attachments`, `references`, `resources`, `paths` (arrays, optional): safe
  WebChat context supplied by AchillesCLI.
- `origin` (object, optional): generic surface metadata.
- `timeoutMs` (number, optional): provider task timeout.

When invoked by AchillesCLI WebChat, the script uses the Ploinky SDK with the explicitly supplied agent identity and optional user-delegation grant. Router policy and the provider's authentication requirements still apply. An unavailable provider or missing required grant fails explicitly.

Example:
launch-open-interpreter run the test suite and summarize failures

## Output Format
Returns a structured object:

```json
{
  "ok": true,
  "backend": "open-interpreter",
  "cacheable": false,
  "result_text": "natural-language answer",
  "persistence_hint": {
    "ku_type": "code_work",
    "record_result": true,
    "ttl_hint_seconds": null
  },
  "diagnostics": {}
}
```

## Constraints
- Never submit tasks directly to `openInterpreterAgent`; its `oi_status` tool is used only to check provider availability.
- Always dispatch through `copilotProviderRelay.copilot_provider_task_submit`.
- Require the current runtime's router invocation capability for delegated MCP.
- Treat `@open-interpreter` as ordinary chat text, not a dispatch token.
- Never serve Open Interpreter execution from AKU cache.

## Execution

Run `node <skill-directory>/scripts/run.mjs --input 'run the test suite and summarize failures'`. The wrapper accepts exactly one string input, imports its local `scripts/ploinkyInvocation.mjs`, which uses the Ploinky MCP client directly, awaits `scripts/action.mjs`, prints its JSON result, and awaits invocation closure to persist provider results.

The action uses the SDK's `callAgentTool` capability to query `copilotProviderRelay.copilot_provider_list_backends`, check the catalog provider through `oi_status`, and submit through the relay. `scripts/toolResponse.mjs` extracts JSON text from MCP responses and retains explicit MCP and invalid-JSON errors. All skill helpers remain inside this folder; the parent retains guarded generated-local transport checks and refuses uncertified transport without fallback.

Only file references are forwarded as paths; directory and non-file references become prompt warnings. Resources and origin metadata are forwarded through the runtime's filtering, with the canonical parent workspace authoritative over requested origin or cwd. Provider task timeout defaults to 110000 ms and is clamped to 1000–120000 ms. The parent uses 30000 ms for discovery/status and the task timeout plus 330000 ms for submission transport.

Missing capability, unreachable relay/provider, missing catalog backend, and submission errors return structured diagnostics without claiming successful work. Every result is non-cacheable, is appended to the invocation's provider-result journal, and is flushed on close. Only completed submission responses request `code_work` result persistence; unavailable results do not.
