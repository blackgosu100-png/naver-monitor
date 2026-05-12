-- Run this after the Supabase Auth migration when upgrading from one snapshot per day
-- to multiple timestamped snapshots per day.

ALTER TABLE stock_history
    ADD COLUMN IF NOT EXISTS fetch_key TEXT;

UPDATE stock_history
SET fetch_key = fetch_date::TEXT
WHERE fetch_key IS NULL;

ALTER TABLE stock_history
    ALTER COLUMN fetch_key SET NOT NULL;

ALTER TABLE stock_history
    DROP CONSTRAINT IF EXISTS uq_user_comp_date;

ALTER TABLE stock_history
    DROP CONSTRAINT IF EXISTS uq_user_comp_fetch_key;

ALTER TABLE stock_history
    ADD CONSTRAINT uq_user_comp_fetch_key UNIQUE(user_id, competitor_id, fetch_key);

CREATE INDEX IF NOT EXISTS idx_stock_history_user_fetch_key
    ON stock_history(user_id, fetch_key);
