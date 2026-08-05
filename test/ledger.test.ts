import { describe, expect, it } from "vitest";
import { createWorker } from "../src/app";
import { MemoryStore, TestProviders, signedLineRequest } from "./support";

describe("shared fund ledger", () => {
  it("posts a clear natural-language expense and exposes the new balance", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({
      intent: "transactions",
      transactions: [{ type: "expense", amount: 300, date: "2026-08-04", majorCategory: "飲食", smallCategory: "晚餐", note: "三哥" }],
    });
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("晚餐三哥300", { eventId: "expense-1" }), providers.env);
    await worker.fetch(await signedLineRequest("餘額", { eventId: "balance-1" }), providers.env);

    expect(providers.replies[0]?.text).toContain("飲食／晚餐");
    expect(providers.replies[0]?.text).toContain("NT$300");
    expect(providers.replies[0]?.flex).toHaveProperty("body");
    expect(providers.replies[1]?.text).toContain("-NT$300");
    expect(providers.replies[1]?.text).toContain("餘額（本月存入未完成）");
    expect(providers.geminiInputs).toEqual(["晚餐三哥300"]);

    await worker.fetch(await signedLineRequest("最近紀錄", { eventId: "recent-1" }), providers.env);
    expect(providers.replies.at(-1)?.text).toContain("支出 NT$300 飲食／晚餐");
    expect(providers.replies.at(-1)?.text).not.toContain("ID:");
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

    expect(providers.replies.at(-1)?.text).toContain("餘額：NT$5,000");
    expect(providers.replies.at(-1)?.text).toContain("你：NT$5,000");
    expect(providers.replies.at(-1)?.text).toContain("另一位：NT$0");
    expect(providers.replies.at(-1)?.text).not.toContain("SPOUSE_");

    await worker.fetch(await signedLineRequest("本月明細", { eventId: "month-detail" }), providers.env);
    expect(providers.replies.at(-1)?.text).toContain("#1 2026-08-04 存入 NT$5,000");
    expect(providers.replies.at(-1)?.text).not.toContain("contribution");
  });

  it("counts a confirmed high-value deposit toward the monthly contribution status", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push(
      { intent: "transactions", transactions: [{ type: "contribution", amount: 20000, date: "2026-08-04" }] },
      { intent: "zero_contribution" },
    );
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("本月存入20000", { eventId: "large-contribution", userId: "SPOUSE_A" }), providers.env);
    const confirmationId = JSON.stringify(providers.replies.at(-1)?.flex).match(/action=confirm&id=([\w-]+)/)?.[1];
    expect(confirmationId).toBeTruthy();
    await worker.fetch(await signedLineRequest(`確認 ${confirmationId}`, { eventId: "large-contribution-confirm", userId: "SPOUSE_A" }), providers.env);
    await worker.fetch(await signedLineRequest("我這個月不存", { eventId: "large-contribution-other", userId: "SPOUSE_B" }), providers.env);
    await worker.fetch(await signedLineRequest("餘額", { eventId: "large-contribution-balance", userId: "SPOUSE_A" }), providers.env);

    const balanceReply = providers.replies.at(-1)?.text ?? "";
    expect(balanceReply).toContain("餘額：NT$20,000");
    expect(balanceReply).toContain("你：NT$20,000");
    expect(balanceReply).toContain("另一位：NT$0");
    expect(balanceReply).not.toContain("本月存入未完成");
  });

  it("shows the cached LINE display name as the recorder of every transaction", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push(
      { intent: "transactions", transactions: [{ type: "contribution", amount: 8000, date: "2026-08-04" }] },
      { intent: "transactions", transactions: [{ type: "expense", amount: 300, date: "2026-08-04", majorCategory: "飲食", smallCategory: "晚餐", note: "牛肉麵" }] },
    );
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("存入8000", { eventId: "named-a", userId: "SPOUSE_A" }), providers.env);
    await worker.fetch(await signedLineRequest("晚餐牛肉麵300", { eventId: "named-b", userId: "SPOUSE_B" }), providers.env);
    await worker.fetch(await signedLineRequest("最近紀錄", { eventId: "named-recent", userId: "SPOUSE_A" }), providers.env);

    const recent = providers.replies.at(-1)?.text ?? "";
    expect(recent).toContain("記錄者：卡村");
    expect(recent).toContain("記錄者：Tiffany");
    expect(providers.memberNameCalls).toEqual([
      { groupId: "GROUP", userId: "SPOUSE_A" },
      { groupId: "GROUP", userId: "SPOUSE_B" },
    ]);
  });
});
