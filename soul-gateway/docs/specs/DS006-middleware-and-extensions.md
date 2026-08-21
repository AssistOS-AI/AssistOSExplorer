---
title: DS006-middleware-and-extensions
summary: Defines kernel middleware composition, scope bindings, catalogs, built-in policy modules, provider middleware, and runtime extensions.
---

## Introduction

Soul Gateway uses one asynchronous kernel contract for route, gateway, model, provider, and backend execution. Catalogs and bindings let administrators apply policy without coupling public protocols to individual modules.

## Core Content

### Kernel contract

A middleware must use the asynchronous <code>(ctx, next)</code> contract and must call <code>next()</code> at most once. A terminal must set the expected context result and must not call a missing next function. The shared request context carries route, request, identity, authentication, snapshot, target, response, services, logging, metadata, cancellation, and error state across scopes.

Middleware may perform work before and after <code>next()</code>. Post-phase behavior must account for reverse unwind order. A middleware that short-circuits must set a complete response or throw a classified error.

### Scopes and bindings

Gateway bindings apply to every request. Model bindings apply to the resolved direct or cascade model. Provider bindings apply inside each direct-model attempt after the target and credential lease are known. A binding must declare its scope, target where required, middleware key, order, enabled state, and settings. Gateway bindings must not declare a target; model and provider bindings must declare one.

The [middleware catalog](../wiki.html#definition-middleware-catalog) must resolve enabled modules and bindings from the snapshot and preserve deterministic ordering. Settings must merge only through the precedence rules owned by the middleware framework; a request override must not bypass a key, model, provider, or gateway restriction unless the affected policy explicitly permits it.

### Built-in middleware

The built-in catalog may provide request logging, rate limiting, token tracking, budget enforcement, content blocking, response filtering, loop detection, system-prompt injection, session context, response caching, context compression, and output compression. Each built-in must publish metadata and a factory, validate or default its settings, and state whether it acts before dispatch, after dispatch, or across streaming events.

Content and budget rules that protect a mandatory security or cost boundary must fail closed according to their specialized specification. Logging, caching, compression, and optional enrichment failures should not replace a valid model result unless their module contract marks the failure as mandatory.

### Provider middleware

[Provider middleware](../wiki.html#definition-provider-middleware) must run within an attempt and may use the chosen model, provider, and credential context without exposing secrets. The registry must load built-ins and validated extension modules. Recompilation on each retry may observe a refreshed binding generation, but the model and snapshot invariants of the request must remain explicit.

### Backends and extensions

Every [provider backend](../wiki.html#definition-provider-backend) must have a validated manifest and an <code>execute()</code> function. The backend catalog must wrap execution once into a terminal and serve both the hot path and lifecycle operations from the same registered module. Built-in and extension backends must follow the same manifest and error-classification contract.

The extension loader may discover backends, middleware, and provider middleware under <code>EXTENSIONS_DIR</code>. Invalid manifests or modules must not enter the active generation. Rescans must create replaceable catalog generations and give in-flight work a grace period before old generation cleanup.

### Extension service boundary

The extension SDK may expose model invocation, credential signing, and token estimation through constrained services. Credential helpers must lease and release credentials internally and must return signed headers rather than secret storage records. Recursive model invocation must require an active snapshot and must preserve the same security, routing, and policy boundaries as a normal internal model call.
