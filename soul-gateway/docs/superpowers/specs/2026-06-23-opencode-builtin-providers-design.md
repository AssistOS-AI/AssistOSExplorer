# OpenCode Zen + OpenCode Go builtin providers — design

- **Date:** 2026-06-23
- **Status:** Approved (design); implementation plan to follow
- **Scope:** Add OpenCode Zen and OpenCode Go to the builtin provider preset
  catalog and keep the preset-catalog test in sync. Preset + test only — no
  deploy-time key seeding, no `API_KEYS.md` edits.

## Background

The gateway's "builtin provider" mechanism is the static `PROVIDER_PRESETS`
catalog in `src/runtime/providers/provider-presets.mjs`. A preset is a
configuration bundle (no code) that references a loaded backend module via
`adapter_key` and fills in `base_url`, display name, and auth defaults.
`BackendCatalog.getTemplates()` (`src/runtime/backends/backend-catalog.mjs`)
merges every preset whose `adapter_key` backend is currently loaded into the
dashboard "Add Provider" dropdown.

Both OpenCode endpoints are OpenAI-compatible, so they reuse the already-loaded
`openai-api` backend through the shared `OPENAI_COMPAT_DEFAULTS` bundle — the
same path used by NVIDIA, Groq, OpenRouter, Fireworks, etc. No backend code,
no `achillesAgentLib` transport change, and no provider allowlist edits are
required: provider creation is not gated on a known-key list, and the
preset file's own contract states "Extend here — no code changes needed
elsewhere."

## Verified facts (read-only probes, 2026-06-23)

| Probe | Result |
|-------|--------|
| `GET https://opencode.ai/zen/v1/models` | HTTP 200, OpenAI list (`claude-opus-4-8`, `claude-fable-5`, `claude-sonnet-4-6`, …) |
| `POST https://opencode.ai/zen/v1/chat/completions` (no auth) | HTTP 401, OpenAI-shaped error (route exists, parses `model`) |
| `GET https://opencode.ai/zen/go/v1/models` | HTTP 200, OpenAI list (`glm-5.2`, `kimi-k2.7-code`, `minimax-m3`, …) |
| `POST https://opencode.ai/zen/go/v1/chat/completions` (no auth) | HTTP 401 `{"error":{"type":"AuthError","message":"Missing API key."}}` |
| `GET https://opencode.ai/go/v1/models` | HTTP 404 (marketing SPA) — wrong base |

- **OpenCode Go's working base URL is `https://opencode.ai/zen/go/v1`**, not
  `https://opencode.ai/go/v1`. The design uses the verified URL.
- Auth is `Authorization: Bearer <key>`, which the `openai-api` backend already
  emits (`openai-api.backend.mjs` `Bearer ${token}`).
- OpenCode Zen additionally exposes `/messages` (Anthropic) and `/responses`
  (OpenAI) surfaces for native clients. Soul Gateway routes through
  `/chat/completions`, the universal OpenAI-compatible surface, which is
  verified to exist for both endpoints.

## Design

### Change 1 — `src/runtime/providers/provider-presets.mjs`

Insert two entries in the "OpenAI-compatible vendors" section, after the
`cohere` preset and before the Anthropic-direct block:

```js
    Object.freeze({
        // OpenCode Zen — curated multi-vendor coding-model gateway. The
        // /zen/v1 base also exposes /messages and /responses for native
        // clients, but /chat/completions is the universal OpenAI-compatible
        // surface the openai-api backend targets.
        key: 'opencode-zen',
        display_name: 'OpenCode Zen',
        base_url: 'https://opencode.ai/zen/v1',
        ...OPENAI_COMPAT_DEFAULTS,
    }),
    Object.freeze({
        // OpenCode Go — flat-rate subscription tier serving open coding
        // models (GLM, Kimi, MiMo, Qwen, MiniMax, DeepSeek). Note the base
        // lives under /zen/go/v1, NOT /go/v1.
        key: 'opencode-go',
        display_name: 'OpenCode Go',
        base_url: 'https://opencode.ai/zen/go/v1',
        ...OPENAI_COMPAT_DEFAULTS,
    }),
```

### Change 2 — `src/test/unit/providers.test.mjs`

The `preset catalog merge` describe block is the only test that asserts the
real preset catalog. Two edits:

1. In `includes openai-compat presets when the openai-api backend is loaded`:
   add `'opencode-zen'` and `'opencode-go'` to the iterated key list so they
   get real coverage (adapter_key `openai-api`, kind `external_api`,
   auth_strategy `api_key`, non-empty `base_url`).
2. In `total dropdown count: hidden dispatchers contribute zero, presets
   surface in full`: change the comment from `22 vendor presets = 22 entries`
   to `24 vendor presets = 24 entries`, and add both keys to the
   `openaiPresetKeys` array. The final `Object.keys(templates).length` assertion
   is computed from the arrays, so it rebalances to 24 automatically.

No other test references the real catalog: the `getTemplates()` occurrences in
`management.test.mjs` are local stubs, and `snapshot.test.mjs` uses fixed
provider records.

## Acceptance criteria

1. `getProviderPresets()` returns entries for both `opencode-zen` and
   `opencode-go`, each with `adapter_key: 'openai-api'`, `kind: 'external_api'`,
   `auth_strategy: 'api_key'`, and the verified base URLs above.
2. With the `openai-api` backend loaded, `BackendCatalog.getTemplates()`
   includes both keys; total OpenAI-compat preset count is 15 and total
   dropdown count (openai + search + anthropic dispatchers loaded) is 24.
3. `node --experimental-test-module-mocks --test src/test/unit/providers.test.mjs`
   passes.
4. `npm run test:unit` passes with no regressions.

## Verification commands

```bash
cd soul-gateway
node --experimental-test-module-mocks --test src/test/unit/providers.test.mjs
npm run test:unit
```

## Caveats (documented, not blocking)

- **stream_options**: enabled by default for unknown providers in the
  `openai-api` backend; only `nvidia` is disabled. OpenCode proxies multiple
  model families, so `stream_options.include_usage` support is not guaranteed
  upstream. Low risk and overridable per-provider via settings
  `supports_stream_options: false`. Default left enabled.
- **Pricing/metadata**: OpenCode's `/models` returns minimal fields, so the
  metadata-enrichment pipeline may leave some OpenCode models without pricing.
  Non-blocking and out of scope.

## Out of scope

- Deploy-time secret seeding (GitHub secret → Ploinky env var → auto-created
  account). Only `OPENROUTER_API_KEY` is wired this way today.
- `API_KEYS.md` reference edits. The gitignored file already has an `opencode`
  Zen row; reconciling it to `opencode-zen` and adding `opencode-go` can be a
  follow-up.

## Rollback

Revert the two edits. Presets are pure data and additive, so removing the two
`PROVIDER_PRESETS` entries and the test keys fully reverts the change with no
migration or state impact.
