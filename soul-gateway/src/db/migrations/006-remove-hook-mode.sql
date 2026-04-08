-- Remove legacy hook-mode metadata from middleware definitions.
--
-- Gateway and provider middleware now use a single native middleware
-- contract. `middlewares.hook_mode` was only needed by the old
-- pre/post adapter layer and is no longer part of the active runtime.

SET search_path TO soul_gateway, public;

ALTER TABLE middlewares
    DROP COLUMN IF EXISTS hook_mode;
