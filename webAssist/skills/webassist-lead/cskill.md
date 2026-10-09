# webassist-lead

## Description
Creates or updates a site-scoped lead after profile match and contact information are validated.

## Input Format
- `promptText` contains a JSON object with:
  - `siteId` and `sessionId` are not needed: the runtime supplies the active site and session through its trusted context, and any values in the payload are ignored.
  - `profile` (string, required)
  - `contactInfo` (object, required)

## Output Format
- Plain text only.
