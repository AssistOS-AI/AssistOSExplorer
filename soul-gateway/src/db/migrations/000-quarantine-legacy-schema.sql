-- Preserve pre-v2 tables that used canonical table names but do not match the
-- canonical schema. This lets 001-initial-schema create the v2 tables cleanly
-- without deleting the old data.

CREATE SCHEMA IF NOT EXISTS soul_gateway;
SET search_path TO soul_gateway, public;

CREATE OR REPLACE FUNCTION pg_temp.quarantine_legacy_table(
    p_table_name text,
    p_required_columns text[]
) RETURNS void AS $$
DECLARE
    source_regclass regclass;
    target_name text;
    target_regclass regclass;
    suffix text;
    is_legacy boolean;
BEGIN
    source_regclass := to_regclass(format('soul_gateway.%I', p_table_name));
    IF source_regclass IS NULL THEN
        RETURN;
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM unnest(p_required_columns) AS required(column_name)
        WHERE NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'soul_gateway'
              AND table_name = p_table_name
              AND column_name = required.column_name
        )
    ) INTO is_legacy;

    IF NOT is_legacy THEN
        RETURN;
    END IF;

    target_name := format('legacy_%s_pre_v2', p_table_name);
    target_regclass := to_regclass(format('soul_gateway.%I', target_name));
    IF target_regclass IS NOT NULL THEN
        suffix := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS');
        target_name := format('legacy_%s_pre_v2_%s', p_table_name, suffix);
    END IF;

    EXECUTE format(
        'ALTER TABLE soul_gateway.%I RENAME TO %I',
        p_table_name,
        target_name
    );
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM soul_gateway.schema_migrations
        WHERE version = '001-initial-schema'
    ) THEN
        RETURN;
    END IF;

    PERFORM pg_temp.quarantine_legacy_table(
        'api_keys',
        ARRAY[
            'key_ciphertext',
            'key_iv',
            'key_auth_tag',
            'status',
            'metadata',
            'updated_at',
            'revoked_at'
        ]
    );

    PERFORM pg_temp.quarantine_legacy_table(
        'middlewares',
        ARRAY[
            'middleware_key',
            'source_type',
            'hook_mode',
            'module_path',
            'checksum',
            'default_settings',
            'metadata',
            'updated_at'
        ]
    );

    PERFORM pg_temp.quarantine_legacy_table(
        'blacklist_rules',
        ARRAY[
            'rule_key',
            'match_type',
            'case_sensitive',
            'metadata',
            'updated_at'
        ]
    );
END $$;
