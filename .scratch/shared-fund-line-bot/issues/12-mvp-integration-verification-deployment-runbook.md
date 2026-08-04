# 12 — MVP integration verification and deployment runbook

**What to build:** Prove the complete two-person shared-fund workflow against the specification and provide a repeatable zero-cost deployment runbook that another agent can follow without hidden architectural decisions.

**Blocked by:** 01 — Secure LINE Worker foundation; 02 — Natural-language expense ledger; 03 — Ambiguous, batch, and high-value safeguards; 04 — Monthly contribution lifecycle; 05 — Balance alerts and core queries; 06 — Transaction editing, deletion, and refunds; 07 — Monthly reminders, close, and carryover; 08 — Ordered processing and closed-month reconciliation; 09 — Google Drive monthly CSV; 10 — Spending analysis charts; 11 — Privacy and zero-cost failure hardening.

**Status:** ready-for-agent

- [ ] The full acceptance matrix in the MVP spec passes through the Worker-handler seam and externally observable provider boundaries.
- [ ] Ledger rebuild reproduces current balance, fund-month states, carryovers, net category totals, and report figures from append-oriented history.
- [ ] End-to-end tests prove duplicate, concurrent, expired, wrong-user, wrong-group, delayed, and repeated scheduled events produce no duplicate side effects.
- [ ] A clean deployment can configure the two LINE user IDs, group ID, fixed taxonomy, Gemini key, Drive authorization, chart signing secret, and Asia/Taipei schedules.
- [ ] The runbook documents every provider's free plan, hard application limit, disabled paid fallback, and expected fail-closed symptom at quota exhaustion.
- [ ] The runbook verifies LINE additional messages are disabled, Gemini has no billing project, Cloudflare remains on Workers/D1 Free, and Drive uses standard no-additional-cost quota.
- [ ] The deployed smoke test covers help, contribution activation, clear expense, balance query, correction, close, CSV, chart, and privacy suspension without using real financial data.
- [ ] No Web administration UI, historical import, spouse debt calculation, non-text bookkeeping, editable taxonomy, paid failover, or other out-of-scope behavior is introduced.
