# 01 — Secure LINE Worker foundation

**What to build:** Deliver a deployable, zero-paid-fallback LINE Bot foundation that accepts authentic events only from the designated two-person bookkeeping group, records each event once in a deterministic inbox, and can answer `說明` through the same production request path used by later bookkeeping features.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] A valid signed text webhook from either allowlisted spouse in the configured group receives a `說明` response listing the agreed commands and text-only MVP constraint.
- [ ] Invalid signatures, wrong groups, and non-allowlisted users cause no command processing, external AI call, financial response, or ledger mutation.
- [ ] Replaying the same `webhookEventId` produces one durable event and at most one durable response state.
- [ ] Events are stored with enough status to distinguish received, processing, completed, and retryable failure without treating inbox state as ledger truth.
- [ ] Equal or concurrent events have a documented deterministic ordering key based on LINE event time and event identity.
- [ ] The D1 schema and indexes support the inbox, authorization state, and future ledger slices while remaining within free-tier constraints.
- [ ] The primary test seam submits signed LINE or scheduled events to the Worker handler and asserts observable response plus D1 state with only external providers replaced.
- [ ] Deployment configuration uses Cloudflare Workers Free and D1 Free with no paid fallback.

