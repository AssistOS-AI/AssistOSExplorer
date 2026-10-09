# webassist-session

## Description
Creates and updates site-scoped WebAssist visitor session profile records.

## Input Format
- `promptText` contains a JSON object with:
  - `siteId` and `sessionId` are not needed: the runtime supplies the active site and session through its trusted context, and any values in the payload are ignored.
  - `profileDetails` (string[], optional)
  - `contactInformation` (object, optional)

## Output Format
- Plain text only.
