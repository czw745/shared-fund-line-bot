import { describe, expect, it } from "vitest";
import { createWorker } from "../src/app";
import { MemoryStore, TestProviders, signedLineRequest } from "./support";

describe("shared fund ledger", () => {
  it("posts a clear natural-language expense and exposes the new balance", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({
      intent: "transactions",
      transactions: [{ type: "expense", amount: 300, date: "2026-08-04", majorCategory: "飲食", smallCategory: "正餐", note: "三哥" }],
    });
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("晚餐三哥300", { eventId: "expense-1" }), providers.env);
    await worker.fetch(await signedLineRequest("餘額", { eventId: "balance-1" }), providers.env);

    expect(providers.replies[0]?.text).toContain("飲食／正餐");
    expect(providers.replies[0]?.text).toContain("NT$300");
    expect(providers.replies[1]?.text).toContain("-NT$300");
    expect(providers.replies[1]?.text).toContain("暫估");
    expect(providers.geminiInputs).toEqual(["晚餐三哥300"]);
  });

  it("activates a month after both spouses declare their contribution", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push(
      { intent: "transactions", transactions: [{ type: "contribution", amount: 5000, date: "2026-08-04", note: "本月存入" }] },
      { intent: "zero_contribution" },
    );
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("本月存入5000", { eventId: "contribution-a", userId: "SPOUSE_A" }), providers.env);
    await worker.fetch(await signedLineRequest("我這個月不存", { eventId: "contribution-b", userId: "SPOUSE_B" }), providers.env);
    await worker.fetch(await signedLineRequest("餘額", { eventId: "active-balance" }), providers.env);

    expect(providers.replies.at(-1)?.text).toContain("目前餘額：NT$5,000");
    expect(providers.replies.at(-1)?.text).toContain("SPOUSE_B:NT$0");
  });
});
