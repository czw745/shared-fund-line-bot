import { emptyState } from "./domain";
import type { ErrorSummary, EventRecord, GroupState, Store } from "./types";

export class D1Store implements Store {
  constructor(private readonly db: D1Database) {}

  async beginEvent(record: EventRecord): Promise<boolean> {
    const result = await this.db.prepare(
      `INSERT OR IGNORE INTO webhook_events
       (id, group_id, user_id, event_timestamp, status, raw_payload, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(record.id, record.groupId, record.userId, record.timestamp, record.status, record.raw ?? null, record.expiresAt ?? null, Date.now()).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async finishEvent(id: string, status: EventRecord["status"], errorCode?: string): Promise<void> {
    await this.db.prepare("UPDATE webhook_events SET status = ?, error_code = ?, updated_at = ? WHERE id = ?").bind(status, errorCode ?? null, Date.now(), id).run();
  }

  async errorSummary(groupId: string, sinceTimestamp: number): Promise<ErrorSummary> {
    const result = await this.db.prepare(
      `SELECT error_code, COUNT(*) AS count
       FROM webhook_events
       WHERE group_id = ? AND event_timestamp >= ?
         AND status IN ('failed_retryable', 'reply_pending')
         AND error_code IS NOT NULL
       GROUP BY error_code`,
    ).bind(groupId, sinceTimestamp).all<{ error_code: string; count: number }>();
    const byCode = Object.fromEntries(result.results.map((row) => [row.error_code, Number(row.count)]));
    return { total: Object.values(byCode).reduce((sum, count) => sum + count, 0), byCode };
  }

  async saveCsvExport(token: string, csv: string, filename: string, expiresAt: number): Promise<void> {
    await this.db.prepare("INSERT INTO csv_exports (token, csv_text, filename, expires_at) VALUES (?, ?, ?, ?)")
      .bind(token, csv, filename, expiresAt).run();
  }

  async loadCsvExport(token: string): Promise<{ csv: string; filename: string; expiresAt: number } | undefined> {
    const row = await this.db.prepare("SELECT csv_text, filename, expires_at FROM csv_exports WHERE token = ?")
      .bind(token).first<{ csv_text: string; filename: string; expires_at: number }>();
    return row ? { csv: row.csv_text, filename: row.filename, expiresAt: row.expires_at } : undefined;
  }

  async loadState(groupId: string): Promise<GroupState> {
    const row = await this.db.prepare("SELECT state_json FROM group_states WHERE group_id = ?").bind(groupId).first<{ state_json: string }>();
    return row ? JSON.parse(row.state_json) as GroupState : emptyState(groupId);
  }

  async saveState(state: GroupState): Promise<void> {
    await this.db.prepare(
      `INSERT INTO group_states (group_id, state_json, version, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(group_id) DO UPDATE SET state_json = excluded.state_json, version = group_states.version + 1, updated_at = excluded.updated_at`,
    ).bind(state.groupId, JSON.stringify(state), Date.now()).run();
  }

  async cleanup(beforeTimestamp: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM webhook_events WHERE expires_at IS NOT NULL AND expires_at < ?").bind(beforeTimestamp),
      this.db.prepare("DELETE FROM chart_tokens WHERE expires_at < ?").bind(beforeTimestamp),
      this.db.prepare("DELETE FROM csv_exports WHERE expires_at < ?").bind(beforeTimestamp),
    ]);
  }

  async withGroupLock<T>(groupId: string, action: () => Promise<T>): Promise<T> {
    const owner = crypto.randomUUID();
    let acquired = false;
    for (let attempt = 0; attempt < 200 && !acquired; attempt += 1) {
      const now = Date.now();
      const result = await this.db.prepare(
        `INSERT INTO group_locks (group_id, owner, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
         WHERE group_locks.expires_at < ?`,
      ).bind(groupId, owner, now + 55_000, now).run();
      acquired = (result.meta.changes ?? 0) === 1;
      if (!acquired) await scheduler.wait(25);
    }
    if (!acquired) throw new Error("Group is busy");
    try {
      return await action();
    } finally {
      await this.db.prepare("DELETE FROM group_locks WHERE group_id = ? AND owner = ?").bind(groupId, owner).run();
    }
  }
}
