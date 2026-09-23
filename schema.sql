CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site        TEXT NOT NULL,
  guid        TEXT NOT NULL,
  url         TEXT NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  published   TEXT,                 -- feed 的發布時間，ISO UTC
  found_at    TEXT NOT NULL,        -- 第一次在 feed 看到的時間，ISO UTC
  -- new: 待寫文案 / review: 等人核准 / ready: 待發 / posted / dryrun / skipped / expired / failed
  status      TEXT NOT NULL DEFAULT 'new',
  text        TEXT,                 -- 貼文內文（不含網址）
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  posted_at   TEXT,
  post_id     TEXT,
  UNIQUE (site, guid)
);

CREATE INDEX IF NOT EXISTS items_site_status ON items (site, status);
CREATE INDEX IF NOT EXISTS items_site_posted ON items (site, posted_at);
