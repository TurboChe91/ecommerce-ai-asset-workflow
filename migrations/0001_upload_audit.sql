CREATE TABLE IF NOT EXISTS tryon_upload_sessions (
  id TEXT PRIMARY KEY,
  style_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  planned_create INTEGER NOT NULL DEFAULT 0,
  planned_overwrite INTEGER NOT NULL DEFAULT 0,
  planned_skip INTEGER NOT NULL DEFAULT 0,
  completed_create INTEGER NOT NULL DEFAULT 0,
  completed_overwrite INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (style_id) REFERENCES tryon_styles(id)
);

CREATE TABLE IF NOT EXISTS tryon_upload_events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  actor_email TEXT NOT NULL,
  style_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  tone TEXT,
  view TEXT,
  action TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  previous_etag TEXT,
  new_etag TEXT,
  size INTEGER,
  width INTEGER,
  height INTEGER,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES tryon_upload_sessions(id),
  FOREIGN KEY (style_id) REFERENCES tryon_styles(id)
);

CREATE INDEX IF NOT EXISTS idx_tryon_upload_sessions_style
  ON tryon_upload_sessions(style_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tryon_upload_events_style
  ON tryon_upload_events(style_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tryon_upload_events_session
  ON tryon_upload_events(session_id, created_at);
