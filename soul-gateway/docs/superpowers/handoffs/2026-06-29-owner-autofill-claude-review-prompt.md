# Claude Code Review Prompt

Paste the prompt below into Claude Code from this workspace:

```text
You are reviewing a candidate Soul Gateway fix. This is a review-only task.

Workspace:
/Users/danielsava/work/file-parser/proxies/soul-gateway

Read the repository instructions first:
- /Users/danielsava/work/file-parser/CLAUDE.md
- /Users/danielsava/work/file-parser/proxies/CLAUDE.md
- /Users/danielsava/work/file-parser/proxies/soul-gateway/CLAUDE.md

Do not edit files.
Do not stage files.
Do not commit.
Do not push.
Do not redeploy.

The candidate implementation already exists as local commits on main. Review it as a patch range:

Base: f50bde0
Head: b3acaf8

The handoff files under docs/superpowers/handoffs are not part of the implementation under review.

Problem:
The Soul Gateway dashboard create-key owner field was blank even though the user was already logged into Ploinky as an admin. Ploinky forwards verified user info in x-ploinky-auth-info, but Soul Gateway's management route wrapper previously discarded the verified auth result, and the dashboard had no server-authoritative current-user endpoint.

Intended behavior:
- Prefill the user API key owner from the verified Ploinky login user.
- Keep the owner editable for admins who intentionally create keys for another owner.
- Do not trust browser-provided identity for owner derivation.
- Preserve key formats:
  - Stored subject id: user:<owner>:<name>
  - Ploinky mint userId: <owner>:<name>

Review these files in the diff:
- src/management/management-user.mjs
- src/management/session-route.mjs
- src/management/build-routes.mjs
- src/test/unit/management-user.test.mjs
- src/test/unit/management.test.mjs
- src/dashboard/js/app.mjs
- src/test/unit/dashboard-keys-page.test.mjs
- docs/specs/DS012-api-reference.md
- docs/specs/DS016-ploinky-agent-mode.md
- docs/superpowers/plans/2026-06-29-autofill-user-key-owner.md

Run/read:

git status --short
git diff --stat f50bde0..b3acaf8
git diff f50bde0..b3acaf8

Then run verification:

node --test src/test/unit/management-user.test.mjs
node --experimental-test-module-mocks --test src/test/unit/management.test.mjs
node --test src/test/unit/dashboard-keys-page.test.mjs
npm test
git diff --check f50bde0..b3acaf8

Review questions:
1. Does owner derivation use only the verified Ploinky router identity?
2. Does GET /management/me expose only non-secret current-user data?
3. Is the keyOwner derivation order correct: username, name, id, email?
4. Is owner normalization correct for [A-Za-z0-9._-]+ and local:admin -> admin?
5. Does the dashboard prefill owner while preserving admin override behavior?
6. Do stored subjectId and minted userId stay compatible with the existing key contract?
7. Are there security issues, trust-boundary leaks, or regressions?
8. Are the tests sufficient? Pay special attention to:
   - no explicit admin override regression test
   - whitespace-only owner input failing validation instead of falling back to currentOwner
9. Do DS012 and DS016 accurately document the implementation?
10. Should anything be changed before push or deploy?

Output format:

Findings first, ordered by severity:
- Critical
- Important
- Minor

For each finding include:
- file and line
- what is wrong
- why it matters
- suggested fix

Then include:
- verification commands run and results
- open questions
- final recommendation: approve, approve with minor follow-up, or block
```
