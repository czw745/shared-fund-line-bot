# 06 — Transaction editing, deletion, and refunds

**What to build:** Let each spouse correct only their own recent transactions through LINE while retaining a complete audit trail and representing refunds as spending reversals rather than ordinary income.

**Blocked by:** 03 — Ambiguous, batch, and high-value safeguards; 04 — Monthly contribution lifecycle.

**Status:** ready-for-agent

- [ ] `修改` lists only the requesting spouse's latest ten active transactions.
- [ ] Each eligible transaction exposes edit and delete actions, and expenses also expose a refund action.
- [ ] Selecting edit opens a same-sender, transaction-bound context for ten minutes and accepts a complete natural-language replacement.
- [ ] Replacement content passes the same Gemini, taxonomy, amount, date, ambiguity, and high-value safeguards as a new transaction.
- [ ] Editing creates a new revision while preserving the original input and prior version.
- [ ] Deleting creates a void revision and never physically removes ledger history.
- [ ] A spouse cannot edit, delete, refund, or confirm a transaction created by the other spouse.
- [ ] A refund links to the original expense where possible and reduces that expense category's net spending.
- [ ] Full, partial, and repeated refunds are supported, but cumulative linked refunds cannot exceed the original expense.
- [ ] An unlinked refund requires selection of one approved category before posting.
- [ ] Editing or deleting a monthly contribution updates the fund-month activation state consistently.

