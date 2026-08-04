# 03 — Ambiguous, batch, and high-value safeguards

**What to build:** Safely handle messages containing multiple transactions, uncertain classifications, or unusually large amounts by creating sender-bound candidates that must be resolved before the ledger changes.

**Blocked by:** 02 — Natural-language expense ledger.

**Status:** ready-for-agent

- [ ] One clear message containing multiple expenses posts the entire batch atomically and returns a coherent receipt summary.
- [ ] If any transaction in a batch is ambiguous or invalid, none of the batch posts before resolution.
- [ ] An unclassifiable expense offers two or three valid small-category buttons and never invents an `其他` category.
- [ ] Any single transaction of NT$10,000 or more requires explicit confirmation even when all fields are otherwise unique.
- [ ] Every candidate has an opaque ID, is bound to the originating user and group, and expires after ten minutes.
- [ ] A wrong user, wrong group, expired action, payload mismatch, or replayed action cannot confirm or mutate a candidate.
- [ ] A Gemini failure stores a no-ledger-effect retry state and offers the original sender a retry action.
- [ ] Gemini calls are hard-limited to 100 per Asia/Taipei day before making the outbound request; exact commands remain usable after exhaustion.
- [ ] Provider exhaustion or failure never invokes a paid model or alternate paid service.

