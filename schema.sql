CREATE TABLE IF NOT EXISTS posts (
  id           TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL,
  chat_title   TEXT,
  message_id   INTEGER,
  created_at   TEXT NOT NULL,
  local_date   TEXT NOT NULL,
  is_weekend   INTEGER NOT NULL,
  source       TEXT NOT NULL,
  provider     TEXT,
  model        TEXT,
  prompt       TEXT,
  asset_ref    TEXT,
  asset_name   TEXT,
  tg_file_id   TEXT,
  latency_ms   INTEGER,
  status       TEXT NOT NULL,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_posts_chat     ON posts(chat_id);
CREATE INDEX IF NOT EXISTS idx_posts_date     ON posts(local_date);
CREATE INDEX IF NOT EXISTS idx_posts_provider ON posts(provider);

CREATE TABLE IF NOT EXISTS votes (
  post_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  username   TEXT,
  vote       INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_votes_post ON votes(post_id);

CREATE TABLE IF NOT EXISTS gen_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,
  chat_id     TEXT,
  provider    TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  http_status INTEGER,
  latency_ms  INTEGER,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_genlog_provider ON gen_log(provider);
CREATE INDEX IF NOT EXISTS idx_genlog_date     ON gen_log(created_at);
