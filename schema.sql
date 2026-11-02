-- Схема базы D1 для BugalterSZ. Применяется один раз (и безопасна для повторного запуска).

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  nick         TEXT NOT NULL,
  nick_lc      TEXT NOT NULL UNIQUE,
  pass         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  ledger_start INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  exp        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions (exp);

CREATE TABLE IF NOT EXISTS auth_hits (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_hits ON auth_hits (ip, ts);

CREATE TABLE IF NOT EXISTS ledger (
  id     TEXT PRIMARY KEY,
  uid    TEXT NOT NULL,
  type   TEXT NOT NULL,
  amount INTEGER NOT NULL,
  note   TEXT NOT NULL DEFAULT '',
  ts     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_uid_ts ON ledger (uid, ts);

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  text       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_uid ON notes (uid, updated_at);

-- служебные значения: курсор сканера, блокировка тика, токен EXBO, счётчики
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS scan_state (
  k         TEXT PRIMARY KEY,       -- "регион:предмет"
  region    TEXT NOT NULL,
  item_id   TEXT NOT NULL,
  hot       INTEGER NOT NULL DEFAULT 0,
  last_scan INTEGER NOT NULL,
  seen      TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_scan_hot ON scan_state (hot, last_scan);

CREATE TABLE IF NOT EXISTS baselines (
  k    TEXT PRIMARY KEY,            -- "регион:предмет"
  at   INTEGER NOT NULL,
  ok   INTEGER NOT NULL,
  data TEXT NOT NULL                -- история продаж: [время, цена за шт., качество, заточка]
);

CREATE TABLE IF NOT EXISTS feed (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL UNIQUE,
  region     TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deals (
  key      TEXT PRIMARY KEY,
  item_key TEXT NOT NULL,
  region   TEXT NOT NULL,
  item_id  TEXT NOT NULL,
  score    REAL NOT NULL,
  end_time INTEGER NOT NULL DEFAULT 0,
  data     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deals_item ON deals (item_key);
CREATE INDEX IF NOT EXISTS idx_deals_score ON deals (score);

-- Время входов: для страницы аккаунта
CREATE TABLE IF NOT EXISTS user_login (
  uid        TEXT PRIMARY KEY,
  last_login INTEGER NOT NULL,
  prev_login INTEGER NOT NULL DEFAULT 0
);

-- Личный чёрный список: скрытые предметы не показываются в новых и выгодных лотах, но находятся поиском
CREATE TABLE IF NOT EXISTS user_hidden (
  uid     TEXT NOT NULL,
  item_id TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (uid, item_id)
);
