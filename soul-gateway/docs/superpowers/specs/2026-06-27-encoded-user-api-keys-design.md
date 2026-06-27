# Design Spec - Encoded User API Keys

Date: 2026-06-27
Status: Design approved
Repos touched: `ploinky` and `proxies/soul-gateway`

## Summary

User-created Soul Gateway API keys must be shown and used as an encoded public
token instead of exposing the signed-subject payload directly. The public key
format is:

```text
sk-soul-<base64url(user:<owner>:<name>|<ed25519-signature>)>
```

The visible key must not contain the literal strings `user` or `v1`, and it must
not expose the owner/name or admin-created subject text. The encoded payload
keeps the existing security model: Ploinky still signs the exact subject id,
Soul Gateway still verifies that signature with `PLOINKY_AGENT_API_PUBLIC_KEY`,
and the gateway still stores only the `api_keys` policy row.

This is an intentional breaking change for user keys. Raw user signed-subject
tokens such as `user:alice:laptop|...` are rejected after this change. Existing
raw user keys must be recreated.

## Current Behavior

Ploinky's `POST /api/router/identity/user-api-key` endpoint returns a raw
signed-subject key:

```text
user:<owner>:<name>|<ed25519-signature>
```

The Soul Gateway dashboard displays that value once after creating a user key.
The same raw value is accepted by the gateway's inbound API-key verifier. This
works cryptographically, but it exposes the user/admin subject structure to the
person receiving the key.

## Decisions

| Decision | Detail |
| --- | --- |
| Public token prefix | Use `sk-soul-`. |
| Public token payload | Base64url-encode the existing raw signed-subject key. |
| Visible marker removal | Do not include `user`, `v1`, owner, name, or admin id as readable text in the public key. |
| Storage | Do not add key material storage; `api_keys.subject_id` remains the policy lookup key. |
| User-key compatibility | Do not accept raw user signed-subject keys. |
| Agent keys | Leave existing agent runtime key behavior unchanged unless a later design wraps agent keys too. |

## Architecture

### Ploinky Minting

Ploinky keeps the existing Ed25519 signing primitive. For user-key minting,
`buildUserApiKeyResult()` composes the raw signed-subject key as it does today,
then wraps it:

```text
encoded = "sk-soul-" + base64url(rawSignedSubjectKey)
```

The route response's `apiKey` field returns only the encoded key. It may still
return `subjectId` for the admin dashboard orchestration response, because that
response is protected by the authenticated admin session and is not the copied
user-facing token.

### Soul Gateway Verification

Soul Gateway's inbound API-key verifier distinguishes user and agent paths:

1. If the bearer token starts with `sk-soul-`, strip the prefix and base64url
   decode the payload.
2. The decoded payload must be a valid raw signed-subject key whose subject
   classifies as `user`.
3. Verify the Ed25519 signature exactly as today, using the decoded subject id
   and signature.
4. Look up or create the existing `api_keys` row by `subject_id`; enforce
   revoked, expired, rate-limit, and budget rules normally.
5. If a bearer token is raw and classifies as `user`, reject it.
6. Raw agent signed-subject keys continue through the existing agent path.

Malformed encoded keys fail closed as invalid API keys. Examples include a
missing payload, non-base64url payload, decoded text with no delimiter, decoded
agent subjects, decoded invalid subjects, and invalid signatures.

### Dashboard Display

The dashboard keeps the existing create-user-key flow:

1. Provision the user-key policy row through Soul Gateway management.
2. Ask Ploinky to mint the user API key.
3. Display the returned `apiKey` exactly once.

Because Ploinky now returns the wrapped value, the copy box and clipboard action
show only `sk-soul-...`.

## Data Flow

```text
Admin creates user key:
  dashboard
    -> POST /management/keys
       stores subject_id=user:<owner>:<name> policy row
    -> POST /api/router/identity/user-api-key
       signs user:<owner>:<name>
       returns sk-soul-<base64url(raw signed-subject key)>
    -> dashboard shows only sk-soul-...

Caller uses key:
  Authorization: Bearer sk-soul-...
    -> gateway decodes to raw signed-subject key
    -> verifies Ed25519 signature
    -> enforces existing api_keys row policy
```

## Tests

Ploinky unit tests cover:

- User-key route returns `sk-soul-...`, not `user:...|...`.
- The encoded `apiKey` decodes to a signed subject that verifies with the public
  key.
- Non-admin users still cannot mint for another user.
- Invalid requested user ids still return 400.

Soul Gateway unit tests cover:

- `authenticateApiKey()` accepts a valid `sk-soul-...` user key and reuses the
  expected user policy row.
- Raw `user:<id>|<signature>` bearer tokens are rejected.
- Encoded keys whose decoded payload is an agent subject are rejected.
- Malformed encoded payloads are rejected.
- Raw agent signed-subject keys still authenticate.

Dashboard tests, if available for this path, assert that the revealed key starts
with `sk-soul-` and does not contain readable `user:` text.

## Acceptance Criteria

1. Creating a user key in the dashboard reveals only an encoded `sk-soul-...`
   value.
2. The revealed key authenticates to Soul Gateway.
3. Raw user signed-subject bearer tokens are rejected.
4. Existing Ploinky agent runtime keys continue to work.
5. No key material is stored in Soul Gateway beyond the existing policy row.
