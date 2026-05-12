-- ① Supabase SQL Editor에서 이 파일 전체 실행

-- ─── 기존 모니터링 테이블 (로컬앱으로 이전 예정, 호환 유지) ───
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

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON TABLE competitors TO anon, authenticated, service_role;
GRANT ALL ON TABLE stock_history TO anon, authenticated, service_role;
GRANT ALL ON TABLE app_settings TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

-- ─── 관리자 페이지용 신규 테이블 ──────────────────────────────

-- 승인된 수강생 (네이버 ID 화이트리스트)
CREATE TABLE IF NOT EXISTS approved_users (
    naver_id      TEXT PRIMARY KEY,
    display_name  TEXT,
    memo          TEXT,
    expires_at    DATE,
    blocked       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 수강생 PC가 보내는 heartbeat 로그 (사용 현황 파악용)
CREATE TABLE IF NOT EXISTS usage_logs (
    id            BIGSERIAL PRIMARY KEY,
    naver_id      TEXT NOT NULL,
    event         TEXT NOT NULL,                  -- 'verify' | 'heartbeat'
    ip            TEXT,
    user_agent    TEXT,
    app_version   TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_usage_logs_naver_id_created
    ON usage_logs(naver_id, created_at DESC);

-- 강사가 작성하는 공지 (수강생 앱 시작 시 표시)
CREATE TABLE IF NOT EXISTS notices (
    id          BIGSERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
