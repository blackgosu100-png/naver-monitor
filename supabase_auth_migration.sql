-- Use this when upgrading an existing single-admin database to Supabase Auth.
-- For a fresh project, run supabase_schema.sql instead.

ALTER TABLE competitors
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE stock_history
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

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
    ADD CONSTRAINT uq_user_comp_date UNIQUE(user_id, competitor_id, fetch_date);

ALTER TABLE app_settings
    DROP CONSTRAINT IF EXISTS app_settings_pkey;

ALTER TABLE app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY(user_id, key);

CREATE INDEX IF NOT EXISTS idx_competitors_user_id
    ON competitors(user_id);

CREATE INDEX IF NOT EXISTS idx_stock_history_user_date
    ON stock_history(user_id, fetch_date);

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
