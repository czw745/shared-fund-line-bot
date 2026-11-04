ALTER TABLE webhook_events ADD COLUMN error_code TEXT;

CREATE INDEX IF NOT EXISTS idx_webhook_events_status_error
ON webhook_events(status, error_code, event_timestamp);
