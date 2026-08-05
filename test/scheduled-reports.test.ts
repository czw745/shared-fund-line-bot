import { describe, expect, it } from "vitest";
import { createWorker } from "../src/app";
import { MemoryStore, TestProviders, signedLineRequest, signedWebhookEvent } from "./support";

describe("month close and reports", () => {
  it("opens all three analyses from one 圖表 Flex menu", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("圖表", { eventId: "chart-menu" }), providers.env);
    const menu = JSON.stringify(providers.replies.at(-1)?.flex);
    expect(menu).toContain('"label":"本月分析"');
    expect(menu).toContain('"label":"每月趨勢"');
    expect(menu).toContain('"label":"分類趨勢"');
    expect(menu).toContain("action=chart&value=%E6%9C%AC%E6%9C%88%E5%88%86%E6%9E%90");
    expect(providers.geminiInputs).toHaveLength(0);

    await worker.fetch(await signedWebhookEvent({
      type: "postback", webhookEventId: "chart-menu-month", timestamp: Date.UTC(2026, 7, 4, 4), replyToken: "chart-menu-reply",
      source: { type: "group", groupId: "GROUP", userId: "SPOUSE_A" },
      postback: { data: "action=chart&value=%E6%9C%AC%E6%9C%88%E5%88%86%E6%9E%90" },
    }), providers.env);
    expect(providers.replies.at(-1)?.text).toContain("本月分類排行");
  });

  it("closes the prior month, carries its balance, and points to on-demand CSV", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push(
      { intent: "transactions", transactions: [{ type: "contribution", amount: 5000, date: "2026-07-01" }] },
      { intent: "zero_contribution" },
      { intent: "transactions", transactions: [{ type: "expense", amount: 1200, date: "2026-07-30", majorCategory: "飲食", smallCategory: "晚餐", note: "三哥" }] },
    );
    const worker = createWorker({ store, providers });
    const july = Date.UTC(2026, 6, 1, 2);
    await worker.fetch(await signedLineRequest("七月存入5000", { eventId: "july-a", userId: "SPOUSE_A", timestamp: july }), providers.env);
    await worker.fetch(await signedLineRequest("本月不存", { eventId: "july-b", userId: "SPOUSE_B", timestamp: july }), providers.env);
    await worker.fetch(await signedLineRequest("7/30晚餐三哥1200", { eventId: "july-expense", timestamp: Date.UTC(2026, 6, 30, 12) }), providers.env);

    await worker.scheduled?.({ scheduledTime: Date.UTC(2026, 6, 31, 16, 10), cron: "10 16 1 * *", noRetry() {} } as ScheduledEvent, providers.env);
    await worker.scheduled?.({ scheduledTime: Date.UTC(2026, 6, 31, 16, 10), cron: "10 16 1 * *", noRetry() {} } as ScheduledEvent, providers.env);

    expect(providers.pushes).toHaveLength(1);
    expect(providers.pushes[0]?.text).toContain("月底結餘：NT$3,800");
    expect(providers.pushes[0]?.text).toContain("CSV：可從「明細」下載");
  });

  it("returns a readable ranked Flex summary for a single month", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 300, date: "2026-08-04", majorCategory: "飲食", smallCategory: "晚餐", note: "三哥" }] });
    const worker = createWorker({ store, providers });
    await worker.fetch(await signedLineRequest("晚餐300", { eventId: "chart-expense" }), providers.env);
    await worker.fetch(await signedLineRequest("本月分析", { eventId: "chart-query" }), providers.env);

    expect(providers.charts).toHaveLength(0);
    expect(providers.replies.at(-1)?.text).toContain("飲食：NT$300（100%）");
    expect(providers.replies.at(-1)?.text).not.toContain("生活");
    expect(JSON.stringify(providers.replies.at(-1)?.flex)).toContain("本月分類排行");
  });

  it("does not generate an unreadable six-month chart when only one month has data", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 300, date: "2026-08-04", majorCategory: "飲食", smallCategory: "晚餐", note: "三哥" }] });
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("晚餐300", { eventId: "single-month-expense" }), providers.env);
    await worker.fetch(await signedLineRequest("分類趨勢", { eventId: "single-month-category-trend" }), providers.env);

    expect(providers.charts).toHaveLength(0);
    expect(providers.replies.at(-1)?.text).toContain("累積至少 2 個月後顯示趨勢圖");
    expect(providers.replies.at(-1)?.text).toContain("飲食：NT$300（100%）");
  });

  it("keeps only active months and non-zero categories in a real category trend", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push(
      { intent: "transactions", transactions: [{ type: "expense", amount: 300, date: "2026-07-04", majorCategory: "飲食", smallCategory: "晚餐", note: "晚餐" }] },
      { intent: "transactions", transactions: [{ type: "expense", amount: 500, date: "2026-08-04", majorCategory: "購物", smallCategory: "日用品", note: "清潔用品" }] },
    );
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("7/4 晚餐300", { eventId: "trend-july", timestamp: Date.UTC(2026, 6, 4, 12) }), providers.env);
    await worker.fetch(await signedLineRequest("8/4 清潔用品500", { eventId: "trend-august", timestamp: Date.UTC(2026, 7, 4, 12) }), providers.env);
    await worker.fetch(await signedLineRequest("分類趨勢", { eventId: "trend-query", timestamp: Date.UTC(2026, 7, 5, 12) }), providers.env);

    expect(providers.charts).toHaveLength(1);
    expect(providers.charts[0]?.data.labels).toEqual(["2026-07", "2026-08"]);
    expect(providers.charts[0]?.data.datasets.map((dataset) => dataset.label)).toEqual(["飲食", "購物"]);
  });

  it("requires same-sender confirmation before changing a closed month", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push(
      { intent: "transactions", transactions: [{ type: "contribution", amount: 1000, date: "2026-07-01" }] },
      { intent: "zero_contribution" },
      { intent: "transactions", transactions: [{ type: "expense", amount: 300, date: "2026-07-30", majorCategory: "飲食", smallCategory: "晚餐", note: "補登晚餐" }] },
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
    expect(store.states.get("GROUP")?.months["2026-07"]?.closingBalance).toBe(700);
  });
});
