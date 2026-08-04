# 08 — Ordered processing and closed-month reconciliation

**What to build:** Keep balances and month boundaries correct when spouses send concurrently, scheduled jobs race with messages, or a user intentionally posts a transaction to a closed month.

**Blocked by:** 06 — Transaction editing, deletion, and refunds; 07 — Monthly reminders, close, and carryover.

**Status:** ready-for-agent

- [ ] Ledger-affecting user events and scheduled jobs for the group commit in one deterministic order.
- [ ] Concurrent spouse messages produce monotonic transaction sequences and receipts whose balances never appear to go backward.
- [ ] Month close cannot interleave with an uncommitted earlier event and create an inconsistent carryover.
- [ ] Transaction month is based on effective date and LINE event time, not Worker processing time.
- [ ] A pre-midnight event delivered or redelivered after close posts once to the prior month as infrastructure delay without user confirmation.
- [ ] A user-initiated entry, edit, delete, or refund targeting a closed month first shows the exact downstream balance impact.
- [ ] Closed-month confirmation is bound to the original sender and proposed payload, has an opaque confirmation code, and expires after five minutes.
- [ ] A confirmed historical change recomputes the affected closing balance, every dependent opening balance, current balance, summaries, and relevant threshold state.
- [ ] Wrong-user, expired, replayed, or mismatched historical confirmations have no ledger effect.

