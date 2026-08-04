import { describe, expect, it } from "vitest";
import { createWorker } from "../src/app";
import { MemoryStore, TestProviders, signedLineRequest } from "./support";

describe("safety and lifecycle workflows", () => {
  it("holds a high-value transaction for same-sender confirmation", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 12000, date: "2026-08-04", majorCategory: "購物", smallCategory: "家電", note: "冰箱" }] });
    const worker = createWorker({ store, providers });
    await worker.fetch(await signedLineRequest("冰箱12000", { eventId: "large" }), providers.env);
    const confirmation = providers.replies.at(-1)?.text.match(/確認 ([\w-]+)/)?.[1];
    expect(confirmation).toBeTruthy();

    await worker.fetch(await signedLineRequest(`確認 ${confirmation}`, { eventId: "wrong", userId: "SPOUSE_B" }), providers.env);
    await worker.fetch(await signedLineRequest("餘額", { eventId: "before" }), providers.env);
    expect(providers.replies.at(-1)?.text).toContain("NT$0");

    await worker.fetch(await signedLineRequest(`確認 ${confirmation}`, { eventId: "right", userId: "SPOUSE_A" }), providers.env);
    await worker.fetch(await signedLineRequest("餘額", { eventId: "after" }), providers.env);
    expect(providers.replies.at(-1)?.text).toContain("-NT$12,000");
  });

  it("voids and refunds only the sender's transactions through 修改", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 800, date: "2026-08-04", majorCategory: "娛樂", smallCategory: "聚會", note: "聚餐" }] });
    const worker = createWorker({ store, providers });
    await worker.fetch(await signedLineRequest("聚餐800", { eventId: "meal" }), providers.env);
    await worker.fetch(await signedLineRequest("修改", { eventId: "manage" }), providers.env);
    const transactionId = providers.replies.at(-1)?.text.match(/ID:([\w-]+)/)?.[1];
    expect(transactionId).toBeTruthy();

    await worker.fetch(await signedLineRequest(`退款 ${transactionId} 300`, { eventId: "refund" }), providers.env);
    await worker.fetch(await signedLineRequest("餘額", { eventId: "refunded-balance" }), providers.env);
    expect(providers.replies.at(-1)?.text).toContain("-NT$500");
  });
});
