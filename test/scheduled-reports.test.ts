import { describe, expect, it } from "vitest";
import { createWorker } from "../src/app";
import { MemoryStore, TestProviders, signedLineRequest } from "./support";

describe("month close and reports", () => {
  it("closes the prior month, carries its balance, and exports one CSV", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push(
      { intent: "transactions", transactions: [{ type: "contribution", amount: 5000, date: "2026-07-01" }] },
      { intent: "zero_contribution" },
      { intent: "transactions", transactions: [{ type: "expense", amount: 1200, date: "2026-07-30", majorCategory: "飲食", smallCategory: "正餐", note: "三哥" }] },
    );
    const worker = createWorker({ store, providers });
    const july = Date.UTC(2026, 6, 1, 2);
    await worker.fetch(await signedLineRequest("七月存入5000", { eventId: "july-a", userId: "SPOUSE_A", timestamp: july }), providers.env);
    await worker.fetch(await signedLineRequest("本月不存", { eventId: "july-b", userId: "SPOUSE_B", timestamp: july }), providers.env);
    await worker.fetch(await signedLineRequest("7/30晚餐三哥1200", { eventId: "july-expense", timestamp: Date.UTC(2026, 6, 30, 12) }), providers.env);

    await worker.scheduled?.({ scheduledTime: Date.UTC(2026, 6, 31, 16, 10), cron: "10 16 1 * *", noRetry() {} } as ScheduledEvent, providers.env);
    await worker.scheduled?.({ scheduledTime: Date.UTC(2026, 6, 31, 16, 10), cron: "10 16 1 * *", noRetry() {} } as ScheduledEvent, providers.env);

    expect(providers.uploads).toHaveLength(1);
    expect(providers.uploads[0]?.month).toBe("2026-07");
    expect(providers.uploads[0]?.csv).toContain("三哥");
    expect(providers.pushes).toHaveLength(1);
    expect(providers.pushes[0]?.text).toContain("月底結餘：NT$3,800");
  });

  it("returns deterministic aggregate chart data", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 300, date: "2026-08-04", majorCategory: "飲食", smallCategory: "正餐", note: "三哥" }] });
    const worker = createWorker({ store, providers });
    await worker.fetch(await signedLineRequest("晚餐300", { eventId: "chart-expense" }), providers.env);
    await worker.fetch(await signedLineRequest("本月分析", { eventId: "chart-query" }), providers.env);

    expect(providers.charts).toHaveLength(1);
    expect(providers.charts[0]?.data.datasets[0]?.values).toEqual([300, 0, 0, 0, 0]);
    expect(providers.replies.at(-1)?.text).toContain("https://worker.test/charts/");
  });

  it("requires same-sender confirmation before changing a closed month", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push(
      { intent: "transactions", transactions: [{ type: "contribution", amount: 1000, date: "2026-07-01" }] },
      { intent: "zero_contribution" },
      { intent: "transactions", transactions: [{ type: "expense", amount: 300, date: "2026-07-30", majorCategory: "飲食", smallCategory: "正餐", note: "補登晚餐" }] },
    );
    const worker = createWorker({ store, providers });
    const july = Date.UTC(2026, 6, 1, 2);
    await worker.fetch(await signedLineRequest("七月存入1000", { eventId: "closed-fund-a", timestamp: july }), providers.env);
    await worker.fetch(await signedLineRequest("本月不存", { eventId: "closed-fund-b", userId: "SPOUSE_B", timestamp: july }), providers.env);
    await worker.scheduled?.({ scheduledTime: Date.UTC(2026, 6, 31, 16, 10), cron: "10 16 1 * *", noRetry() {} } as ScheduledEvent, providers.env);

    await worker.fetch(await signedLineRequest("7/30補登晚餐300", { eventId: "late", timestamp: Date.UTC(2026, 7, 4, 4) }), providers.env);
    const confirmation = providers.replies.at(-1)?.text.match(/確認 ([\w-]+)/)?.[1];
    expect(providers.replies.at(-1)?.text).toContain("已關帳月份");
    await worker.fetch(await signedLineRequest(`確認 ${confirmation}`, { eventId: "late-confirm", timestamp: Date.UTC(2026, 7, 4, 4, 1) }), providers.env);
    await worker.fetch(await signedLineRequest("餘額", { eventId: "late-balance" }), providers.env);

    expect(providers.replies.at(-1)?.text).toContain("NT$700");
    expect(providers.uploads).toHaveLength(2);
    expect(providers.uploads[1]?.existingFileId).toBe("drive-2026-07");
  });
});
