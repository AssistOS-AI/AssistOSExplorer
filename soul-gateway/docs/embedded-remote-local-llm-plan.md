# Embedded Remote Local LLM Default Plan

Date: 2026-05-25

## Goal

Make Explorer's embedded Soul Gateway deployment work out of the box with the RAAS LM Studio endpoint while preserving standalone Soul Gateway behavior and true local no-auth LLM deployments.

## Constraints

1. Standalone Soul Gateway remains unchanged.
2. Embedded Soul Gateway remains a Ploinky dependency of Explorer.
3. Request-time LLM execution continues through `achillesAgentLib`; Soul Gateway only configures providers, leases credentials, discovers models, and normalizes streams.
4. The LM Studio proxy token is a deployment secret. It must not be stored in git, docs, logs, plugin assets, or static files.
5. The remote LM Studio endpoint requires `Authorization: Bearer <token>`.
6. LM Studio lists installed models, but cold requests to unloaded models are unreliable. The embedded default should expose one preloaded model unless an operator explicitly enables discovery.

## Step-by-Step Implementation

1. Add Soul Gateway env support:
   - `LOCAL_LLM_API_KEY` for the Caddy bearer token.
   - `LOCAL_LLM_DISCOVERY_MODE` with default `single`.
   - keep `LOCAL_LLM_BASE_URL` and `LOCAL_LLM_MODEL`.

2. Update the embedded manifest profile:
   - `LOCAL_LLM_BASE_URL=https://lmstudio.axiologic.dev/v1`.
   - `LOCAL_LLM_MODEL=gemma-3-12b-it`.
   - `LOCAL_LLM_DISCOVERY_MODE=single`.
   - `LOCAL_LLM_API_KEY` optional and secret-supplied by deployment.

3. Update `bootstrapLocalLlmProvider`:
   - create `local-llm` with `authStrategy: "api_key"` when `LOCAL_LLM_API_KEY` is present.
   - create `local-llm` with `authStrategy: "none"` when no token is present for no-auth local endpoints.
   - store the token through the existing encrypted provider account path.
   - use `LOCAL_LLM_DISCOVERY_MODE=single` to create only `local-llm/<LOCAL_LLM_MODEL>` without calling `/models`.
   - keep `auto` mode for operators who want model discovery.

4. Update Explorer deployment:
   - accept the LM Studio token from GitHub secrets.
   - pass optional `LOCAL_LLM_*` variables through the remote env file.
   - persist them with `ploinky var` before `ploinky start`.

5. Update docs/specs:
   - DS016 describes token-backed embedded bootstrap and single-model default.
   - DS013 describes deployment profile defaults.
   - Explorer deploy docs mention the `LMSTUDIO_PROXY_TOKEN` secret and optional overrides.

6. Update tests:
   - embedded bootstrap creates auth-free providers when no token exists.
   - embedded bootstrap creates API-key providers and encrypted provider accounts when a token exists.
   - single discovery mode creates only the configured fallback model.
   - auto discovery mode preserves existing discovery behavior.

7. Verify:
   - run the local LLM bootstrap unit test.
   - run related embedded management/auth tests if touched.
   - run syntax checks for edited JavaScript and workflow YAML where practical.
