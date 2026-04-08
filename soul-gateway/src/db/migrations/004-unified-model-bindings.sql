-- Unified model strategy + unified middleware bindings.
--
-- This migration establishes the target schema for the middleware-first
-- runtime. It does NOT migrate historical data from the old
-- `main`-branch Soul Gateway app schema under `soul-gateway/app/`.
-- Importing production data from that schema is handled by the
-- dedicated application-level importer:
--
--   src/db/import/import-main-branch-data.mjs
--
-- This file is therefore target DDL, not the full production cutover.
-- Operators should migrate the target schema first, then run the
-- importer against the source database before switching traffic.
--
-- After this migration the schema has one addressable target concept
-- (a model, with a strategy_kind that is either 'direct' or
-- 'cascade') and one binding concept (middleware_bindings, keyed by
-- scope and target id).
--
--   * Cascade fallback lives in `model_children` (parent → children).
--   * Middleware scope lives in `middleware_bindings.scope` ∈
--     {'gateway','model','provider'}.  `scope='gateway'` rows have
--     `target_id = NULL`; `scope='model'` rows point at models.id;
--     `scope='provider'` rows point at providers.id.
--   * There is no separate provider_hook_assignments table; provider-
--     scope middleware bindings replace it.
--   * There is no separate tier_id on middleware bindings; middleware
--     bound to a former tier is now bound to the cascade model that
--     replaced that tier (scope='model', target_id = model.id).

SET search_path TO soul_gateway, public;

-- ── 1. Drop legacy split tables ─────────────────────────────────────
--
-- CASCADE is intentional: we no longer need the foreign keys that
-- middleware_assignments and provider_hook_assignments used to have
-- into tiers / providers.

DROP TABLE IF EXISTS middleware_assignments CASCADE;
DROP TABLE IF EXISTS provider_hook_assignments CASCADE;
DROP TABLE IF EXISTS tier_models CASCADE;
DROP TABLE IF EXISTS tiers CASCADE;

-- ── 2. Extend models for cascade strategy ──────────────────────────

ALTER TABLE models
    ADD COLUMN IF NOT EXISTS strategy_kind text NOT NULL DEFAULT 'direct'
        CHECK (strategy_kind IN ('direct', 'cascade'));
ALTER TABLE models
    ADD COLUMN IF NOT EXISTS max_attempts integer;

-- Direct models still require a provider + provider_model_id.  Cascade
-- models do not talk to a provider — they walk their children.  Relax
-- the original NOT NULL constraints accordingly and add a CHECK that
-- enforces the shape per strategy.
ALTER TABLE models ALTER COLUMN provider_id DROP NOT NULL;
ALTER TABLE models ALTER COLUMN provider_model_id DROP NOT NULL;
ALTER TABLE models ALTER COLUMN execution_kind DROP NOT NULL;

-- Drop the original execution_kind CHECK (it forced 'provider_model'
-- and siblings) so cascade models can leave the column null.
DO $$
DECLARE
    cname text;
BEGIN
    SELECT conname INTO cname
    FROM pg_constraint
    WHERE conrelid = 'soul_gateway.models'::regclass
        AND pg_get_constraintdef(oid) LIKE '%execution_kind%';
    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE soul_gateway.models DROP CONSTRAINT %I', cname);
    END IF;
END $$;

ALTER TABLE models ADD CONSTRAINT models_strategy_shape_check CHECK (
    (strategy_kind = 'direct'  AND provider_id IS NOT NULL AND provider_model_id IS NOT NULL)
    OR
    (strategy_kind = 'cascade' AND provider_id IS NULL     AND provider_model_id IS NULL)
);

-- ── 3. model_children (cascade child list) ─────────────────────────

CREATE TABLE IF NOT EXISTS model_children (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_model_id     uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    child_model_id      uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    priority            integer NOT NULL CHECK (priority > 0),
    enabled             boolean NOT NULL DEFAULT true,
    settings            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (parent_model_id, child_model_id),
    UNIQUE (parent_model_id, priority),
    CHECK (parent_model_id <> child_model_id)
);

CREATE INDEX IF NOT EXISTS model_children_routing_idx
    ON model_children (parent_model_id, enabled, priority);
CREATE INDEX IF NOT EXISTS model_children_child_idx
    ON model_children (child_model_id);

-- ── 4. middleware_bindings (unified scope/target table) ────────────

CREATE TABLE IF NOT EXISTS middleware_bindings (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scope               text NOT NULL CHECK (scope IN ('gateway', 'model', 'provider')),
    -- Nullable because gateway-scope bindings apply to every request and
    -- have no single target row.  Model bindings point at models.id,
    -- provider bindings point at providers.id.
    target_id           uuid,
    middleware_key      text NOT NULL,
    sort_order          integer NOT NULL DEFAULT 100,
    enabled             boolean NOT NULL DEFAULT true,
    settings            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (scope = 'gateway' AND target_id IS NULL)
        OR
        (scope IN ('model', 'provider') AND target_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS middleware_bindings_scope_enabled_idx
    ON middleware_bindings (scope, enabled, sort_order);
CREATE INDEX IF NOT EXISTS middleware_bindings_target_idx
    ON middleware_bindings (target_id, scope, enabled, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS middleware_bindings_gateway_unique_idx
    ON middleware_bindings (middleware_key)
    WHERE scope = 'gateway';
CREATE UNIQUE INDEX IF NOT EXISTS middleware_bindings_model_unique_idx
    ON middleware_bindings (target_id, middleware_key)
    WHERE scope = 'model';
CREATE UNIQUE INDEX IF NOT EXISTS middleware_bindings_provider_unique_idx
    ON middleware_bindings (target_id, middleware_key)
    WHERE scope = 'provider';
