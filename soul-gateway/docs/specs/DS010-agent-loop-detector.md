# DS010 — Agent Loop Detector

## Summary

This spec describes the behavioral loop detection system that identifies AI agents stuck in repetitive request patterns and intervenes to break the cycle. It runs as a gateway middleware with two detection signals, three response modes, and per-tier / per-model configuration.

## Problem statement

A naive "rapid-fire request rate" heuristic catches nothing useful. Real agent loops have a distinctive signature:

- Agents in loops typically make 2–5 calls/min — well under any sane rapid-fire threshold.
- Each call adds tool results to the conversation, so the raw messages array is technically unique every time. A message-equality check misses these entirely.
- The actual loop signature is: **assistant responses repeat while the conversation grows**. The agent keeps calling the same tool, getting similar results, and producing similar responses, but the cumulative token count grows because tool results keep being appended.

The loop detector captures both of these signals.

## Detection signals

The detector uses two independent signals. Either is sufficient to flag a loop.

### Response similarity

Tracks a fingerprint of each assistant response based on tool calls made and content produced. When a threshold number of recent responses are identical within a rolling window, a loop is detected.

- **Default: 5 of the last 7 responses identical → loop**
- The fingerprint is stable across minor content variation (timestamps, request IDs, etc.) but sensitive to actual behavior change.
- The rolling window is per-session.

### Growth with repetition

Triggers when the conversation has accumulated a large volume of tokens **and** a majority of recent responses are repetitive.

- **Default: conversation has >50K cumulative tokens AND >60% of recent responses are repetitive → loop**
- The cumulative token count is tracked per-session in the session state store.
- This signal catches the "tool-calling in circles" pattern where each iteration technically makes progress (adds tool results to the context) but the agent's behavior isn't actually changing.

## Response modes

Three modes of response are configurable:

- **Intervene** — inject a system message warning the agent that a loop was detected, then allow the request to proceed. This is the friendly default — the agent gets a chance to notice and self-correct. The intervention message is configurable.
- **Block** — reject the request outright with a `loop_detected` error and retry-after guidance. Useful for strict environments where a loop should fail fast.
- **Log** — detect the loop but take no action beyond writing a log entry. Useful for observation mode when tuning the thresholds.

## Minimum window before activation

A minimum number of responses (default 3) must be observed before detection activates, preventing false positives on short conversations. A brand-new session can't be flagged on its first response.

## Session tracking

Session identification for loop detection follows the same rules as DS015:

- If the request carries a session ID header, it's used directly.
- Otherwise, the session is derived from a combination of API key and agent name with an inactivity timeout (default 30 minutes).

Session state (cumulative tokens, recent response fingerprints) is persisted in the session state store so the detector survives restarts.

## Configuration surface

All detection parameters are configurable per tier and per model via middleware assignment overrides:

| Parameter | Default | Description |
|---|---|---|
| `similarity_window` | 7 | Rolling window size for response similarity |
| `similarity_threshold` | 5 | Identical responses out of window size → loop |
| `growth_token_threshold` | 50000 | Cumulative tokens to enable growth signal |
| `growth_repetition_threshold` | 0.6 | Fraction of recent responses that must be repetitive |
| `min_responses` | 3 | Minimum responses observed before activation |
| `mode` | `intervene` | `intervene` / `block` / `log` |
| `intervention_message` | (default text) | System message injected in `intervene` mode |

## Dashboard integration

Detected loops are surfaced in the audit log with a `loop_detected` flag and the triggering signal. The session view in the dashboard highlights sessions with active interventions so operators can see which agents are misbehaving and which interventions are effective.

## Related specs

- **DS003** — the loop detector runs as a gateway middleware (specifically a `both`-type middleware, running in both pre-dispatch and post-dispatch).
- **DS006** — session state table backing the per-session fingerprint and token-count tracking.
- **DS008** — content filtering is a separate kind of content analysis; loop detection is behavioral.
- **DS014** — loop detector is listed in the built-in middleware catalog.
- **DS015** — audit log fields that capture loop detections.
