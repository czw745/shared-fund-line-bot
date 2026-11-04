# High-priority dead-code cleanup

## Goal

Remove code paths that have no supported runtime caller without changing current LINE Bot behaviour or historical ledger compatibility.

## Scope

- Remove the obsolete `month` chart kind; retain `monthly-trend` and `category-trend`.
- Remove the unused `TIME_ZONE` binding; business time remains fixed to `Asia/Taipei` as required by the product specification.
- Remove `linkedTransactionId` from the Gemini response schema because Gemini cannot create refunds.
- Retain `ParsedTransaction.linkedTransactionId`, legacy `refund` handling and CSV output so historical records remain readable.

## Verification

- TypeScript typecheck passes with unused-local and unused-parameter checks.
- Existing automated tests remain unchanged and all pass.
- Repository search finds no obsolete `month` chart kind or `TIME_ZONE` binding.

