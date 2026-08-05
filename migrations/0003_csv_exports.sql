CREATE TABLE IF NOT EXISTS csv_exports (
  token TEXT PRIMARY KEY,
  csv_text TEXT NOT NULL,
  filename TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_csv_exports_expiry ON csv_exports(expires_at);
