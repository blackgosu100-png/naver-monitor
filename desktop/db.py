"""로컬앱용 SQLite DB.

수강생 PC의 %USERPROFILE%\\.naver_monitor\\data.db 에 저장.
"""
import os
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, date, timedelta
from pathlib import Path


def app_data_dir() -> Path:
    base = Path(os.environ.get('USERPROFILE') or os.path.expanduser('~'))
    d = base / '.naver_monitor'
    d.mkdir(parents=True, exist_ok=True)
    return d


DB_PATH = app_data_dir() / 'data.db'


SCHEMA = """
CREATE TABLE IF NOT EXISTS competitors (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    competitor_id   TEXT NOT NULL,
    fetch_date      TEXT NOT NULL,
    total           INTEGER,
    options         TEXT NOT NULL DEFAULT '[]',
    error           TEXT,
    fetched_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(competitor_id, fetch_date),
    FOREIGN KEY(competitor_id) REFERENCES competitors(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_settings (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL DEFAULT ''
);

-- 라이선스 검증 결과 캐시 (오프라인 허용 기간 동안 사용)
CREATE TABLE IF NOT EXISTS license_cache (
    naver_id           TEXT PRIMARY KEY,
    display_name       TEXT,
    expires_at         TEXT,
    last_verified_at   TEXT NOT NULL,
    valid              INTEGER NOT NULL DEFAULT 1
);
"""

DEFAULT_SETTINGS = [
    ('schedule_enabled', 'false'),
    ('schedule_hour',    '9'),
    ('schedule_minute',  '0'),
]


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with get_conn() as c:
        c.executescript(SCHEMA)
        for key, val in DEFAULT_SETTINGS:
            c.execute(
                'INSERT OR IGNORE INTO app_settings(key, value) VALUES (?, ?)',
                (key, val),
            )


# ─── 경쟁사 ──────────────────────────────────────────────────────

def get_competitors() -> list[dict]:
    with get_conn() as c:
        rows = c.execute(
            'SELECT id, name, url, created_at FROM competitors ORDER BY created_at'
        ).fetchall()
        return [dict(r) for r in rows]


def add_competitor(cid: str, name: str, url: str) -> None:
    with get_conn() as c:
        c.execute(
            'INSERT INTO competitors(id, name, url) VALUES (?, ?, ?)',
            (cid, name, url),
        )


def update_competitor(cid: str, fields: dict) -> None:
    if not fields:
        return
    cols = ', '.join(f'{k} = ?' for k in fields)
    with get_conn() as c:
        c.execute(
            f'UPDATE competitors SET {cols} WHERE id = ?',
            (*fields.values(), cid),
        )


def delete_competitor(cid: str) -> None:
    with get_conn() as c:
        c.execute('DELETE FROM competitors WHERE id = ?', (cid,))


# ─── 재고 이력 ────────────────────────────────────────────────────

def save_stock(cid: str, fetch_date: str, result: dict) -> None:
    options_json = json.dumps(result.get('options', []), ensure_ascii=False)
    fetched_at = result.get('fetched_at') or datetime.now().isoformat()
    with get_conn() as c:
        c.execute(
            '''INSERT INTO stock_history (competitor_id, fetch_date, total, options, error, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(competitor_id, fetch_date) DO UPDATE SET
                 total=excluded.total,
                 options=excluded.options,
                 error=excluded.error,
                 fetched_at=excluded.fetched_at''',
            (cid, fetch_date, result.get('total'), options_json,
             result.get('error'), fetched_at),
        )


def get_history(days: int = 14) -> tuple[list[dict], list[dict]]:
    start = (date.today() - timedelta(days=days)).isoformat()
    competitors = get_competitors()
    with get_conn() as c:
        rows = c.execute(
            '''SELECT competitor_id, fetch_date, total, options, error, fetched_at
               FROM stock_history
               WHERE fetch_date >= ?
               ORDER BY fetch_date''',
            (start,),
        ).fetchall()
    parsed = []
    for r in rows:
        d = dict(r)
        try:
            d['options'] = json.loads(d.get('options') or '[]')
        except Exception:
            d['options'] = []
        parsed.append(d)
    return competitors, parsed


# ─── 앱 설정 / 스케줄 ─────────────────────────────────────────────

def get_setting(key: str, default: str = '') -> str:
    with get_conn() as c:
        row = c.execute(
            'SELECT value FROM app_settings WHERE key = ?', (key,)
        ).fetchone()
        return row['value'] if row else default


def set_setting(key: str, value: str) -> None:
    with get_conn() as c:
        c.execute(
            'INSERT INTO app_settings(key, value) VALUES (?, ?) '
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            (key, value),
        )


def get_schedule() -> dict:
    return {
        'enabled': get_setting('schedule_enabled', 'false') == 'true',
        'hour':    int(get_setting('schedule_hour', '9')),
        'minute':  int(get_setting('schedule_minute', '0')),
    }


def save_schedule(enabled: bool, hour: int, minute: int) -> None:
    set_setting('schedule_enabled', 'true' if enabled else 'false')
    set_setting('schedule_hour', str(hour))
    set_setting('schedule_minute', str(minute))


# ─── 라이선스 캐시 ────────────────────────────────────────────────

def save_license_cache(naver_id: str, display_name: str,
                        expires_at: str | None, valid: bool) -> None:
    with get_conn() as c:
        c.execute(
            '''INSERT INTO license_cache (naver_id, display_name, expires_at, last_verified_at, valid)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(naver_id) DO UPDATE SET
                 display_name=excluded.display_name,
                 expires_at=excluded.expires_at,
                 last_verified_at=excluded.last_verified_at,
                 valid=excluded.valid''',
            (naver_id, display_name, expires_at,
             datetime.now().isoformat(), 1 if valid else 0),
        )


def get_license_cache(naver_id: str) -> dict | None:
    with get_conn() as c:
        row = c.execute(
            'SELECT * FROM license_cache WHERE naver_id = ?', (naver_id,)
        ).fetchone()
        return dict(row) if row else None


def get_current_license() -> dict | None:
    """가장 최근에 검증된 라이선스 한 건 (앱이 어느 ID로 동작 중인지)."""
    with get_conn() as c:
        row = c.execute(
            'SELECT * FROM license_cache ORDER BY last_verified_at DESC LIMIT 1'
        ).fetchone()
        return dict(row) if row else None


def clear_license_cache() -> None:
    with get_conn() as c:
        c.execute('DELETE FROM license_cache')
