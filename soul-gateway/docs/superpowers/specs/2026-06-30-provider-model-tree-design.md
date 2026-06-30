# Design Spec - Provider and Model Tree Views

Date: 2026-06-30
Status: Design approved - pending implementation plan
Repos touched: `proxies/soul-gateway`

## Summary

The Soul Gateway dashboard's Providers and Models pages should stay table-based,
but their long flat name lists should become compact expandable trees. Prefixes
become group rows, and leaf rows keep the existing operational columns and
actions.

This is a presentation-layer change. Provider keys, model keys, API payloads,
request routing, logs, and tier membership continue to use the existing stored
identifiers. Ploinky agent providers should display without the `agent:` prefix
so operators scan names like `AchillesIDE/explorer` instead of
`agent:AchillesIDE/explorer`.

## Current Behavior

The Providers page renders every provider as a full table row. Ploinky-discovered
providers use provider keys such as `agent:AchillesIDE/explorer`, so the first
column repeats `agent:` and the same repository prefixes many times.

The Models page renders direct non-cascade models as one flat list. Model keys
often share long prefixes such as `axl-proxy/mistral/...`,
`axl-proxy/copilot-agents/...`, or `AchillesIDE/...`. The repeated prefix text
makes the table visually heavy and pushes the meaningful leaf name late in the
cell.

The existing table layout is still useful because operators can edit, test,
sync, view pipeline state, assign metadata, and toggle enabled state without
opening a separate detail pane.

## Goals

| Goal | Detail |
| --- | --- |
| Compact scanning | Collapse repeated provider and model prefixes into group rows. |
| Preserve workflows | Keep existing row actions, columns, forms, and API behavior intact. |
| Improve Ploinky readability | Display Ploinky providers without the `agent:` prefix. |
| Search remains useful | Search should match visible labels and original full keys. |
| Low-risk implementation | Compute tree view state on the client without database changes. |

## Non-Goals

| Non-goal | Reason |
| --- | --- |
| Changing provider or model keys | Stored keys are part of routing, logs, tiers, and compatibility. |
| Adding a separate explorer pane | A split-pane browser is more disruptive than needed for this cleanup. |
| Reworking provider discovery | Discovery and sync behavior are separate lifecycle concerns. |
| Virtualizing large tables | Useful later, but not required to compact the current lists. |

## Decisions

| Decision | Detail |
| --- | --- |
| Primary UI shape | Use expandable group rows inside the existing tables. |
| Grouping location | Build grouping helpers in dashboard JavaScript from existing row data. |
| Provider display | Strip `agent:` from Ploinky provider display labels only. |
| Data compatibility | Keep raw `provider_key`, `model_key`, and IDs unchanged in API calls. |
| Expand state | Persist expanded/collapsed groups in `localStorage` per page. |
| Filtering | Filtering keeps matching leaves visible and shows their ancestor groups. |

## Architecture

### Shared Tree Helpers

Add small dashboard helpers near the existing formatting functions in
`src/dashboard/js/app.mjs`.

The helpers should:

1. Normalize a raw key into display segments.
2. Build a tree from an array of rows and a key getter.
3. Return flattened render rows for the table.
4. Preserve the original leaf object for action handlers.
5. Compute group metadata such as total leaves and enabled counts.

The helpers should be pure functions where practical, so unit tests can cover
grouping without launching the dashboard.

### Provider Tree

Provider grouping uses the display provider key:

```text
agent:AchillesIDE/explorer -> AchillesIDE / explorer
agent:AchillesCLI/codexAgent -> AchillesCLI / codexAgent
axl-proxy -> axl-proxy
```

Two-segment Ploinky providers render as:

```text
▾ AchillesIDE                         9 providers
  explorer            ploinky-agent-openai   no auth   ...
  gitAgent            ploinky-agent-openai   no auth   ...
```

Single-segment external providers render as leaf rows directly. Do not add an
`external` group for the initial implementation; `axl-proxy` and similar rows
should remain one click away.

Display labels remove `agent:` in the Name and Display Name columns when the
value is a Ploinky agent provider. Tooltips or secondary metadata may still show
the raw stored key for debugging.

### Model Tree

Model grouping uses slash-delimited model keys. The first segment is the root.
An intermediate segment becomes a nested group when that prefix has at least two
leaf descendants. Single-child intermediate chains are compressed so they do not
add visual depth without reducing repetition.

Examples:

```text
axl-proxy/mistral/codestral-2508
  -> axl-proxy / mistral / codestral-2508

AchillesIDE/explorer
  -> AchillesIDE / explorer
```

The Models page should render group rows in the same table:

```text
▾ axl-proxy                           44 models
  ▾ mistral                           18 models
    codestral-2508        api key     chat coding     $0.3/0.9   256k
    codestral-latest      api key     chat coding     -          -
```

Leaf model rows keep the existing columns: billing, tags, pricing, context
window, and enabled. A leaf row's visible name should be the shortest unique
label inside its current group. The full raw model key remains available through
title text, details, edit forms, and API payloads.

### Filtering and Sorting

Filters run against both:

1. the raw stored key, and
2. the visible display path.

When a leaf row matches a filter, all ancestor group rows are included even if
the group label does not match. When a group label matches the filter, all of
that group's descendants remain visible. Otherwise, search results show only
matching leaves plus their ancestors.

Existing sort semantics should remain simple:

1. Groups sort alphabetically by display label.
2. Leaves sort alphabetically by display label inside a group.
3. Enabled and free-only filters apply to leaf rows before grouping.

### Expand and Collapse Behavior

Group rows use compact disclosure controls. The default state should expand the
first level and collapse deeper levels on the Models page, because provider
families such as `axl-proxy/mistral/...` can be large. The Providers page can
default to expanded first-level groups.

Expand/collapse state is stored in localStorage with keys scoped by page and
group path, for example:

```text
soulGateway.providers.tree.expanded
soulGateway.models.tree.expanded
```

Filtering temporarily reveals ancestors for matching leaves even if a group is
collapsed. Clearing the filter returns to the persisted expansion state.

### Table Rendering

The dashboard should render flattened tree rows with a `rowType` field:

| Row type | Purpose |
| --- | --- |
| `group` | Disclosure row with name, count, enabled summary, and empty action cells. |
| `leaf` | Existing provider or model row with all current actions. |

Indentation should be stable and small. Group rows should not be styled as
cards; they remain table rows. Counts should be concise, such as `18 models` or
`7/9 enabled`.

## Data Flow

```text
Providers page:
  GET /management/providers
    -> normalize display labels
    -> apply search/filter
    -> build provider tree
    -> flatten visible rows
    -> existing row actions use original provider object

Models page:
  GET /management/models
    -> normalize direct model list
    -> apply enabled/free/tag/search filters
    -> build model tree
    -> flatten visible rows
    -> existing row actions use original model object
```

## Error Handling

| Case | Behavior |
| --- | --- |
| Empty key | Render as an `unknown` leaf label and keep actions bound to the row. |
| Duplicate display leaf names | Show the minimum number of trailing path segments needed to make labels unique inside the group. |
| Malformed `agent:` key | Strip only the exact leading `agent:` prefix; otherwise display the raw key. |
| localStorage unavailable | Keep expansion state in memory for the current page session. |

## Tests

Unit tests should cover the pure grouping helpers:

- Ploinky provider labels strip `agent:` for display while preserving raw keys.
- Provider grouping produces repo roots such as `AchillesIDE` and leaf labels
  such as `explorer`.
- Model grouping produces nested roots such as `axl-proxy / mistral`.
- Search matches raw keys and visible labels.
- Filtering includes ancestor group rows for matching leaves.
- Duplicate leaf display names expand to unique suffixes.

Dashboard-oriented tests should cover:

- Provider leaf actions still receive the original provider object.
- Model enable/edit/delete actions still receive the original model object.
- Expand/collapse state survives a page refresh when localStorage is available.

## Acceptance Criteria

1. Providers are grouped by readable prefixes and Ploinky providers display
   without the `agent:` prefix.
2. Models are grouped by slash prefixes with nested rows for large provider
   families.
3. Existing provider and model actions continue to work from leaf rows.
4. Search and filters keep matching leaves and their parent groups visible.
5. Raw provider/model keys are unchanged in API calls, edit forms, logs, and
   runtime behavior.
6. The dashboard remains usable at desktop and narrow widths without text
   overlapping adjacent controls.
