SET search_path TO soul_gateway, public;

-- Provider hook assignments (provider-scoped wrappers)
CREATE TABLE IF NOT EXISTS provider_hook_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  hook_key        text NOT NULL,
  phase           text NOT NULL CHECK (phase IN ('request', 'stream', 'response')),
  sort_order      integer NOT NULL DEFAULT 100,
  enabled         boolean NOT NULL DEFAULT true,
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_hook_assignments_provider_idx
  ON provider_hook_assignments (provider_id, enabled, phase, sort_order);

-- Add columns to providers for the new model
ALTER TABLE providers ADD COLUMN IF NOT EXISTS provider_mode text NOT NULL DEFAULT 'external_api'
  CHECK (provider_mode IN ('external_api', 'custom'));
ALTER TABLE providers ADD COLUMN IF NOT EXISTS executor_key text;
