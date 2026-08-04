# 02 — Natural-language expense ledger

**What to build:** Let either spouse type one clear expense in natural language and receive a trustworthy LINE receipt showing that the expense was classified, posted once to the shared ledger, and reflected in the latest provisional or formal balance.

**Blocked by:** 01 — Secure LINE Worker foundation.

**Status:** ready-for-agent

- [ ] Non-command text is sanitized and sent to Gemini without LINE user ID, group ID, or display-name mappings.
- [ ] Gemini structured output is validated by application rules before it can affect the ledger.
- [ ] A uniquely understood expense posts with the correct event-time date, positive integer TWD amount, direction, allowed major category, allowed small category, and note.
- [ ] The fixed taxonomy contains exactly the approved 5 major categories and 30 small categories, and no generated category can be persisted.
- [ ] Messages without dates use Asia/Taipei event date; month/day inputs resolve to the most recent non-future occurrence; future dates are rejected.
- [ ] Zero, negative, decimal, foreign-currency, and non-unique amounts produce no ledger entry.
- [ ] The original input text, actor, effective date, LINE event identity, creation time, and revision lineage are retained with the transaction.
- [ ] The ledger is authoritative and any displayed or cached balance can be rebuilt from active ledger entries starting from NT$0.
- [ ] A successful post returns one compact Flex Message receipt with date, amount, classification, note, transaction sequence, and latest balance; text is the delivery fallback.
- [ ] Gemini or D1 failure leaves the balance unchanged and records a retryable operational outcome.

