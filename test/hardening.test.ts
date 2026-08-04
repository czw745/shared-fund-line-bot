import { describe, expect, it } from "vitest";
import { createWorker } from "../src/app";
import { MemoryStore, TestProviders, signedLineRequest, signedWebhookEvent } from "./support";

describe("privacy and accounting hardening", () => {
  it("alerts once at the lowest newly crossed balance band", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push(
      { intent: "transactions", transactions: [{ type: "contribution", amount: 1500, date: "2026-08-04" }] },
      { intent: "zero_contribution" },
      { intent: "transactions", transactions: [{ type: "expense", amount: 1100, date: "2026-08-04", majorCategory: "購物", smallCategory: "日用品", note: "採買" }] },
    );
    const worker = createWorker({ store, providers });
    await worker.fetch(await signedLineRequest("存入1500", { eventId: "fund-a" }), providers.env);
    await worker.fetch(await signedLineRequest("本月不存", { eventId: "fund-b", userId: "SPOUSE_B" }), providers.env);
    await worker.fetch(await signedLineRequest("採買1100", { eventId: "spend" }), providers.env);
    expect(providers.replies.at(-1)?.text).toContain("低於 NT$500");
    expect(providers.replies.at(-1)?.text).not.toContain("低於 NT$1,000");
  });

  it("suspends bookkeeping while an outsider is in the group", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    const worker = createWorker({ store, providers });
    await worker.fetch(await signedWebhookEvent({ type: "memberJoined", webhookEventId: "join", timestamp: Date.UTC(2026, 7, 4), source: { type: "group", groupId: "GROUP" }, joined: { members: [{ type: "user", userId: "OUTSIDER" }] } }), providers.env);
    await worker.fetch(await signedLineRequest("晚餐300", { eventId: "suspended" }), providers.env);
    expect(providers.geminiInputs).toHaveLength(0);

    await worker.fetch(await signedWebhookEvent({ type: "memberLeft", webhookEventId: "left", timestamp: Date.UTC(2026, 7, 4), source: { type: "group", groupId: "GROUP" }, left: { members: [{ type: "user", userId: "OUTSIDER" }] } }), providers.env);
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 300, date: "2026-08-04", majorCategory: "飲食", smallCategory: "正餐" }] });
    await worker.fetch(await signedLineRequest("晚餐300", { eventId: "resumed" }), providers.env);
    expect(providers.geminiInputs).toEqual(["晚餐300"]);
  });

  it("retries an AI failure without posting twice", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parseFailures = 1;
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 300, date: "2026-08-04", majorCategory: "飲食", smallCategory: "正餐", note: "晚餐" }] });
    const worker = createWorker({ store, providers });
    await worker.fetch(await signedLineRequest("晚餐300", { eventId: "ai-failed" }), providers.env);
    const retryId = providers.replies.at(-1)?.text.match(/重試 ([\w-]+)/)?.[1];
    expect(retryId).toBeTruthy();

    await worker.fetch(await signedLineRequest(`重試 ${retryId}`, { eventId: "ai-retry" }), providers.env);
    await worker.fetch(await signedLineRequest("餘額", { eventId: "ai-retry-balance" }), providers.env);
    expect(providers.replies.at(-1)?.text).toContain("-NT$300");
  });

  it("never confirms an invalid high-value candidate", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: -12000, date: "2026-08-04", majorCategory: "購物", smallCategory: "家電" }] });
    const worker = createWorker({ store, providers });
    await worker.fetch(await signedLineRequest("家電負一萬二", { eventId: "invalid-high" }), providers.env);
    expect(providers.replies.at(-1)?.text).toContain("無效");
    expect(providers.replies.at(-1)?.text).not.toContain("確認 ");
  });
});
