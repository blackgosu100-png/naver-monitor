-- ① Supabase SQL Editor에서 이 파일 전체 실행

CREATE TABLE IF NOT EXISTS competitors (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_history (
    id              BIGSERIAL PRIMARY KEY,
    competitor_id   TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
    fetch_date      DATE NOT NULL,
    total           INTEGER,
    options         JSONB DEFAULT '[]',
    error           TEXT,
    fetched_at      TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_comp_date UNIQUE(competitor_id, fetch_date)
);

CREATE TABLE IF NOT EXISTS app_settings (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL DEFAULT ''
);

INSERT INTO app_settings (key, value) VALUES
    ('schedule_enabled', 'false'),
    ('schedule_hour',    '9'),
    ('schedule_minute',  '0')
ON CONFLICT (key) DO NOTHING;
