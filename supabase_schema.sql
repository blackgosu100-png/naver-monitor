-- Run this in the Supabase SQL Editor.
-- Supabase Auth users are stored in auth.users; app data is separated by user_id.

CREATE TABLE IF NOT EXISTS competitors (
    id          TEXT PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_competitors_user_id
    ON competitors(user_id);

CREATE TABLE IF NOT EXISTS stock_history (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    competitor_id   TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
    fetch_date      DATE NOT NULL,
    total           INTEGER,
    options         JSONB DEFAULT '[]',
    error           TEXT,
    fetched_at      TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_user_comp_date UNIQUE(user_id, competitor_id, fetch_date)
);

CREATE INDEX IF NOT EXISTS idx_stock_history_user_date
    ON stock_history(user_id, fetch_date);

CREATE TABLE IF NOT EXISTS app_settings (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    key     TEXT NOT NULL,
    value   TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, key)
);

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON TABLE competitors TO anon, authenticated, service_role;
GRANT ALL ON TABLE stock_history TO anon, authenticated, service_role;
GRANT ALL ON TABLE app_settings TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

-- Optional hardening if you later expose tables directly through Supabase clients.
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
