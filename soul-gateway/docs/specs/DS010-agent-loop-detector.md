# DS010 — Agent Loop Detector

## Summary

The loop detector is a built-in gateway middleware that looks for repetitive agent behavior and reacts in one of three modes:

- `log`
- `intervene`
- `block`

It uses two signals:

- repeated response fingerprints
- cumulative token growth

## Detection model

The middleware tracks recent response fingerprints per session key and compares them in a rolling window.

It flags likely loops when either:

- recent responses are highly repetitive
- cumulative token growth keeps climbing without meaningful response variation

## Session tracking

Current implementation keeps loop-detector state in memory, keyed by the resolved session key.

That state includes:

- recent response fingerprints
- cumulative token totals

It does not survive process restarts.

## Response modes

- `log` -> record the detection and continue
- `intervene` -> append a system message telling the agent to change course
- `block` -> abort with a loop-detected error

## Configuration

The middleware reads settings from its binding, including:

- `mode`
- `similarityThreshold`
- `window`
- `growthThreshold`
- `minResponses`
- `repetitiveRatio`

Like other gateway middleware, it can be bound globally or to a specific direct/cascade model.

## Related specs

- **DS003** — middleware execution model
- **DS007** — sessions and keys that identify the caller
- **DS014** — built-in loop-detector entry
- **DS015** — observability surfaces that record loop detections
