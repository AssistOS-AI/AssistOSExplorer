---
title: DS001-coding-style
summary: Defines source layout, JavaScript style, module boundaries, file-size guidance, and test organization.
---

## Introduction

This specification is the canonical coding-style and test-organization contract for Soul Gateway. It applies to runtime code, scripts, tests, configuration, and documentation maintained in this project.

## Core Content

### Language and formatting

JavaScript must use ES modules with <code>import</code> and <code>export</code> and four-space indentation. JSON and YAML must use two-space indentation. Documentation, specifications, source comments, identifiers introduced as prose, and operational guidance must be written in English.

Code must use concrete names for actors, data, and effects. Comments must explain a non-obvious invariant or boundary and must not restate the adjacent statement. Repository records must not contain coding-agent attribution or generated-by signatures.

### Source layout and boundaries

The process entry point belongs in <code>src/index.mjs</code>, boot coordination in <code>src/bootstrap.mjs</code> and <code>src/bootstrap/</code>, protocol routes in <code>src/public-api/</code>, and administrative routes in <code>src/management/</code>. Runtime route, execution, middleware, policy, provider, registry, security, and backend responsibilities must remain in their corresponding <code>src/runtime/</code> subdirectories. SQLite schema and data access belong in <code>src/db/</code>; observability belongs in <code>src/observability/</code>; Ploinky discovery belongs in <code>src/ploinky/</code>.

Backend modules must remain scoped to execution-context translation, credential use, provider settings, canonical stream conversion, and error classification. Request-time vendor LLM <code>execute()</code> paths must use [AchillesAgentLib](../wiki.html#definition-achilles-agent-lib) and must not add ad hoc <code>fetch</code>, <code>node:http</code>, or <code>node:https</code> vendor generation calls. Lifecycle probes and model discovery may use direct HTTP only for validation and catalog metadata. The Ploinky-agent backend may own exact-byte serialization, signed request hashing, and Router transport for its authenticated agent capability call.

### Modularity and file size

Each module should own one cohesive responsibility and expose the smallest interface needed by its callers. New behavior should extend an existing domain directory before creating a parallel abstraction. Large route files should delegate resource behavior to focused handler modules, and repeated protocol or DAO logic should move to a domain helper rather than remain duplicated.

Run <code>./fileSizesCheck.sh</code> after structural changes. Files reported above the checker's limits require review for separable responsibilities; generated assets, schema files, and intentionally unwrapped documentation prose may use explicit checker exclusions. JavaScript source lines should remain readable without embedding minified content or large generated payloads.

### Tests

Unit tests belong in <code>src/test/unit/</code> and must isolate route, execution, provider, policy, security, management, registry, and observability contracts with controlled dependencies. Integration tests belong in <code>src/test/integration/</code> and must cover boundaries that require HTTP behavior or embedded SQLite. Reusable fixtures and test helpers belong in <code>src/test/fixtures/</code> and <code>src/test/helpers/</code>.

Behavior changes must add or update the narrowest relevant test and must run <code>npm test</code>. <code>npm run test:unit</code> may be used during iteration but does not replace the complete suite for a cross-subsystem change.

### Documentation synchronization

Changes to behavior, public interfaces, architecture, workflows, or constraints must update both the HTML documentation and affected DS specifications. Specifications are authoritative when explanatory wording diverges. DS numbering must remain contiguous, and rationale, limitations, assumptions, alternatives, and contract boundaries must remain declarative material in <code>Core Content</code> rather than a separate decision log.
