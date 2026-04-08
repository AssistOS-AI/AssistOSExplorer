-- Legacy compatibility cleanup.
--
-- Removes the residual `executor_key` column from `providers` and the
-- now-unused `wrapper` value from the `providers.kind` CHECK constraint.
-- After this migration the only transport-lookup column is `adapter_key`
-- and the only valid kinds are the canonical executor kinds.

SET search_path TO soul_gateway, public;

-- ── 1. Drop executor_key column ─────────────────────────────────────

ALTER TABLE providers DROP COLUMN IF EXISTS executor_key;

-- ── 2. Replace the providers.kind CHECK constraint ──────────────────
--
-- The original constraint allowed `wrapper` and `deep_research`; both
-- are gone now.  We rebuild the constraint with the canonical executor
-- kinds only and rewrite any rows that still have `wrapper` to
-- `external_api` (the natural fallback for an opaque upstream).

UPDATE providers SET kind = 'external_api' WHERE kind = 'wrapper';
UPDATE providers SET kind = 'external_api' WHERE kind = 'deep_research';

DO $$
DECLARE
    cname text;
BEGIN
    SELECT conname INTO cname
    FROM pg_constraint
    WHERE conrelid = 'soul_gateway.providers'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%kind%';
    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE soul_gateway.providers DROP CONSTRAINT %I', cname);
    END IF;
END $$;

ALTER TABLE providers ADD CONSTRAINT providers_kind_check CHECK (
    kind IN ('external_api', 'search', 'local_model', 'custom')
);
