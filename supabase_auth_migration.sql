-- Use this when upgrading an existing single-admin database to Supabase Auth.
-- For a fresh project, run supabase_schema.sql instead.

ALTER TABLE competitors
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE competitors
    ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT '';

ALTER TABLE stock_history
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE stock_history
    ADD COLUMN IF NOT EXISTS fetch_key TEXT;

UPDATE stock_history
SET fetch_key = fetch_date::TEXT
WHERE fetch_key IS NULL;

ALTER TABLE stock_history
    ALTER COLUMN fetch_key SET NOT NULL;

ALTER TABLE app_settings
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Optional: assign old data to one existing teacher account before enabling NOT NULL.
-- Replace the UUID below with the teacher user id from Authentication > Users.
--
-- UPDATE competitors SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
-- UPDATE stock_history SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
-- UPDATE app_settings SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;

ALTER TABLE stock_history
    DROP CONSTRAINT IF EXISTS uq_comp_date;

ALTER TABLE stock_history
    DROP CONSTRAINT IF EXISTS uq_user_comp_date;

ALTER TABLE stock_history
    DROP CONSTRAINT IF EXISTS uq_user_comp_fetch_key;

ALTER TABLE stock_history
    ADD CONSTRAINT uq_user_comp_fetch_key UNIQUE(user_id, competitor_id, fetch_key);

ALTER TABLE app_settings
    DROP CONSTRAINT IF EXISTS app_settings_pkey;

-- Old single-admin settings have no owner. They are not used after Auth migration,
-- and must be removed before user_id can become part of the primary key.
DELETE FROM app_settings
WHERE user_id IS NULL;

ALTER TABLE app_settings
    ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY(user_id, key);

CREATE INDEX IF NOT EXISTS idx_competitors_user_id
    ON competitors(user_id);

CREATE INDEX IF NOT EXISTS idx_stock_history_user_date
    ON stock_history(user_id, fetch_date);

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON TABLE competitors TO anon, authenticated, service_role;
GRANT ALL ON TABLE stock_history TO anon, authenticated, service_role;
GRANT ALL ON TABLE app_settings TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

ALTER TABLE competitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own competitors" ON competitors;
CREATE POLICY "Users can read own competitors"
    ON competitors FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own competitors" ON competitors;
CREATE POLICY "Users can manage own competitors"
    ON competitors FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can read own stock history" ON stock_history;
CREATE POLICY "Users can read own stock history"
    ON stock_history FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own stock history" ON stock_history;
CREATE POLICY "Users can manage own stock history"
    ON stock_history FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can read own settings" ON app_settings;
CREATE POLICY "Users can read own settings"
    ON app_settings FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own settings" ON app_settings;
CREATE POLICY "Users can manage own settings"
    ON app_settings FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
