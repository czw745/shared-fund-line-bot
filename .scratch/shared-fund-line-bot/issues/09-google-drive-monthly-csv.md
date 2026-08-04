# 09 — Google Drive monthly CSV

**What to build:** Preserve a portable monthly ledger in the owner's Google Drive without allowing export failures to corrupt or roll back accounting state.

**Blocked by:** 07 — Monthly reminders, close, and carryover; 08 — Ordered processing and closed-month reconciliation.

**Status:** ready-for-agent

- [ ] The owner can complete one-time Google OAuth authorization and select a personal Drive destination folder without a paid API tier.
- [ ] A successful close creates `共同基金_YYYY-MM.csv` with stable UTF-8 encoding and column order.
- [ ] The CSV includes effective date, direction/type, amount, major category, small category, note, actor label, original input, creation time, revision status, and related original transaction where applicable.
- [ ] The Drive file ID is retained so later generation updates the same file rather than creating duplicates.
- [ ] Any confirmed closed-month ledger change automatically regenerates and updates that month's CSV.
- [ ] Export is outside the accounting commit: Drive failure never reopens or rolls back a closed month.
- [ ] Upload failure retries at most three times with bounded backoff, then records a visible retryable status.
- [ ] A `重新上傳` action is idempotent and updates the same Drive file.
- [ ] OAuth tokens, client secrets, and Drive identifiers do not appear in CSV, logs, LINE messages, or ledger fields.

