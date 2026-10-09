# webassist-site-context

## Description
Reads approved site information, target profiles, owner contact rules, and visitor policy for the active site.

## Input Format
- `promptText` contains a JSON object with:
  - `siteId` and `sessionId` are not needed: the runtime supplies the active site and session through its trusted context, and any values in the payload are ignored.
  - `message` (string, optional) — search text for site context

## Output Format
- Plain text context snapshot.

## Constraints
- Reads only from `context.siteDataDir`.
- Does not call the LLM.
