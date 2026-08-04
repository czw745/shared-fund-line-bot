CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_timestamp INTEGER NOT NULL,
  status TEXT NOT NULL,
  raw_payload TEXT,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_order
  ON webhook_events(group_id, event_timestamp, id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_expiry
  ON webhook_events(expires_at);

CREATE TABLE IF NOT EXISTS group_states (
  group_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chart_tokens (
  token TEXT PRIMARY KEY,
  chart_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chart_tokens_expiry ON chart_tokens(expires_at);

CREATE TABLE IF NOT EXISTS group_locks (
  group_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
