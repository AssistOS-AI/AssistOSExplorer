# Documentation Writing Guidelines

Use this reference for every persistent Soul Gateway document, including `README.md`, `AGENTS.md`, HTML pages, and design specification (DS) files.

## Reader And Purpose

- Write for a reader who has no prior knowledge of the project, its architecture, or its vocabulary.
- State what the project or feature is for before explaining its internal implementation.
- Describe the person who uses the behavior, the task it supports, and the observable result. Then describe configuration, components, and runtime flow.
- Do not address the documentation to the developer who currently maintains the code.
- Keep introductory material at overview level. Move implementation detail to the later section where the reader needs it.

## Product Scope

- Describe only Soul Gateway, its supported behavior, and its actual product dependencies.
- Do not include authoring provenance, tool credits, generated-content notices, or internal documentation workflow details.
- Do not add workspace development tools to product dependency lists, catalogs, architecture diagrams, definitions, or specifications.

## Terms And Reading Order

- Preserve exact code identifiers and record verified plain-language definitions for project-specific terms, acronyms, component names, and architectural concepts on the single canonical `docs/wiki.html` page.
- Do not create a `Definitions` section on an ordinary documentation page. Move supported local definitions into the wiki and remove duplicate entries from the original page.
- Give each wiki term a stable `definition-...` anchor and a detailed explanation supported by the implementation or authoritative project material. Cover the term's meaning, purpose, users or owners, behavior or workflow role, important relationships, and confirmed boundaries or limitations. Do not reduce an entry to a short gloss when more verified context exists.
- Link every eligible occurrence of a defined project-specific term in documentation prose and DS content to its exact canonical wiki anchor. Do not duplicate separate canonical definitions on feature pages.
- Keep page titles and section headings as plain, unlinked text. Never wrap a title, heading, or a word within one in a wiki-definition link; provide the link in the first relevant body-text occurrence instead.
- Retain a useful inline explanation when readers need immediate context, but use it only as narrative support. It never replaces or shortens the detailed canonical wiki entry.
- Do not invent definitions that the implementation or authoritative project material cannot support. Remove or narrow unsupported terminology.
- Repeat brief contextual guidance when an important concept returns after several sections or takes on a new role. Do not reproduce the canonical wiki definition.

## Concrete Language

- Name the real actor, component, action, data, or outcome instead of using a broad noun by itself. Words such as “capability,” “authority,” “mechanism,” “context,” and “layer” need a concrete explanation when they do not identify a specific code construct.
- Name people by their relevant role or field. For example, replace “people with a defined kind of work” with the verified role, such as “people specialized in a certain field.”
- Replace an abstract claim with an observable statement. For example, replace “provides a durable capability” with the operation the user can continue to perform and the condition that keeps it available.
- Avoid literary phrases, slogans, and compressed parallels whose meaning depends on interpretation. State the cause, behavior, and result directly.
- Use the project's established terminology only when it is defined in the source material. If the source does not define a term, remove it or narrow the statement instead of inventing a definition.
- Use examples when they make an abstract rule concrete, but keep each example tied to verified project behavior.

## Text Flow

- Keep each prose block unwrapped in its HTML or Markdown source. Do not insert manual line breaks, hard-wrap at a chosen column, or use hard-coded early wrapping in headings, paragraphs, lists, captions, callouts, diagram labels, DS content, or other text containers.
- Let documentation and DS text flow across the full available width of its own box and wrap naturally only when it reaches that box's boundary. Do not narrow a text container merely to force shorter lines.

## Comparisons

- Use a comparison when it explains a meaningful difference from a real alternative, previous version, or common implementation.
- Name both alternatives and the practical consequence of the difference.
- Do not use “rather than,” “instead of,” or similar contrast as decoration or to say that the system performs a desirable action instead of an obviously undesirable one.
- Prefer a direct affirmative statement when no useful tradeoff or alternative needs explanation.

## Review Method

- Read each document from start to finish in the order available to its intended reader.
- Inventory the project-specific concepts used across all HTML and DS files. Confirm that `docs/wiki.html` contains one detailed, evidence-backed entry with a stable anchor for each concept and that ordinary pages contain no local `Definitions` section.
- Confirm that every eligible occurrence of each defined project-specific term links to its exact wiki anchor. Titles and section headings are required exceptions and must remain unlinked.
- Check prose, lists, diagrams, captions, and callouts. Represent unfamiliar title or heading terms on the wiki, and place their wiki links in relevant body prose rather than inside the title or heading.
- Check every wiki link and confirm that both `docs/wiki.html` and the exact definition anchor exist.
- Confirm documentation and DS text uses the full available width of its own container, remains unwrapped in source prose blocks, and contains no manual or artificially early wrapping.
- Search all persistent documentation for documentation-skill names and authoring-provenance language. Remove each occurrence that describes an internal authoring tool rather than implemented product functionality.
- Rewrite sentences that remain understandable only to a current maintainer or only after reading source code.
