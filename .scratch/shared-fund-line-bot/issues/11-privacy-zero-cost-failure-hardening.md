# 11 — Privacy and zero-cost failure hardening

**What to build:** Harden the completed Bot so provider outages, expired LINE reply tokens, group membership changes, retention rules, and free-tier exhaustion can reduce availability but can never expose data, duplicate accounting, or create a charge.

**Blocked by:** 03 — Ambiguous, batch, and high-value safeguards; 06 — Transaction editing, deletion, and refunds; 07 — Monthly reminders, close, and carryover; 09 — Google Drive monthly CSV; 10 — Spending analysis charts.

**Status:** ready-for-agent

- [ ] A non-allowlisted member joining the configured group immediately privacy-suspends AI calls, transactions, and financial responses.
- [ ] Processing resumes only after all current members are allowlisted again; suspended messages are not retroactively posted.
- [ ] LINE edit and unsend events never modify a posted ledger transaction.
- [ ] Non-text content cannot affect the ledger and receives only the agreed minimal text-only reply.
- [ ] Full webhook payloads and Gemini responses expire after 30 days while transaction original input remains with ledger history.
- [ ] Operational logs redact message text, secrets, OAuth tokens, LINE tokens, signatures, and unnecessary provider identifiers.
- [ ] Reply processing targets LINE's one-minute lifetime and never falls back to a chargeable push when the token expires.
- [ ] An undelivered receipt remains durable and is bundled into the next eligible free reply without repeating the ledger mutation.
- [ ] Scheduled pushes check the current free allowance and are skipped when exhausted without preventing close or CSV export.
- [ ] Workers, D1, Gemini, LINE, Drive, and chart integrations all fail closed and contain no configured paid fallback or automatic upgrade.
- [ ] Operational retries are bounded, idempotent, and can repair outputs without duplicating a ledger effect.

