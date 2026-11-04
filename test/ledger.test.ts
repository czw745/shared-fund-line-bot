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
    expect(JSON.stringify(providers.replies[1]?.flex)).toContain('"text":"-NT$300"');
    expect(providers.geminiInputs).toEqual(["晚餐三哥300"]);

    await worker.fetch(await signedLineRequest("最近紀錄", { eventId: "recent-1" }), providers.env);
    expect(providers.replies.at(-1)?.text).toContain("支出 NT$300 飲食／晚餐");
    expect(providers.replies.at(-1)?.text).not.toContain("ID:");
    expect(JSON.stringify(providers.replies.at(-1)?.flex)).toContain("最近紀錄");
  });

  it("activates a month after both spouses declare their contribution", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push(
      { intent: "zero_contribution" },
    );
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("本月存入5000", { eventId: "contribution-a", userId: "SPOUSE_A" }), providers.env);
    await worker.fetch(await signedLineRequest("我這個月不存", { eventId: "contribution-b", userId: "SPOUSE_B" }), providers.env);
    await worker.fetch(await signedLineRequest("餘額", { eventId: "active-balance" }), providers.env);

    expect(providers.replies.at(-1)?.text).toContain("餘額：NT$5,000");
    expect(providers.replies.at(-1)?.text).toContain("成員甲：NT$5,000");
    expect(providers.replies.at(-1)?.text).toContain("成員乙：NT$0");
    expect(providers.replies.at(-1)?.text).not.toContain("SPOUSE_");

    await worker.fetch(await signedLineRequest("本月明細", { eventId: "month-detail" }), providers.env);
    expect(providers.replies.at(-1)?.text).toContain("#1 2026-08-04 存入 NT$5,000");
    expect(providers.replies.at(-1)?.text).not.toContain("contribution");
    expect(providers.replies.at(-1)?.flex).toHaveProperty("body");
  });

  it("treats each spouse's first plain deposit as a monthly contribution without Gemini", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    // Reproduce the production misclassification if these inputs reach Gemini.
    providers.parses.push(
      { intent: "transactions", transactions: [{ type: "contribution", amount: 8000, date: "2026-10-01" }] },
      { intent: "transactions", transactions: [{ type: "topup", amount: 8000, date: "2026-10-01" }] },
    );
    const worker = createWorker({ store, providers });
    const timestamp = Date.UTC(2026, 9, 1, 11);

    await worker.fetch(await signedLineRequest("存入8000", { eventId: "october-wade", userId: "SPOUSE_A", timestamp }), providers.env);
    await worker.fetch(await signedLineRequest("存入8000", { eventId: "october-tiffany", userId: "SPOUSE_B", timestamp }), providers.env);

    const month = store.states.get("GROUP")?.months["2026-10"];
    expect(providers.geminiInputs).toEqual([]);
    expect(store.states.get("GROUP")?.ledger.map((entry) => entry.type)).toEqual(["contribution", "contribution"]);
    expect(month?.confirmations.SPOUSE_A?.amount).toBe(8000);
    expect(month?.confirmations.SPOUSE_B?.amount).toBe(8000);
    expect(month?.status).toBe("active");
  });

  it("labels the carried balance and contributions with calendar months", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({
      intent: "transactions",
      transactions: [{ type: "contribution", amount: 457, date: "2026-08-31", note: "八月結餘" }],
    });
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("八月存入457", {
      eventId: "august-carryover",
      userId: "SPOUSE_A",
      timestamp: Date.UTC(2026, 7, 31, 12),
    }), providers.env);
    await worker.fetch(await signedLineRequest("餘額", {
      eventId: "september-balance",
      timestamp: Date.UTC(2026, 8, 2, 12),
    }), providers.env);

    const reply = providers.replies.at(-1);
    expect(reply?.text).toContain("8月餘額：NT$457");
    expect(reply?.text).toContain("9月存入：");
    expect(reply?.text).not.toContain("\n本月存入：");
    expect(JSON.stringify(reply?.flex)).toContain('"text":"8月餘額"');
    expect(JSON.stringify(reply?.flex)).toContain('"text":"NT$457"');
    expect(JSON.stringify(reply?.flex)).toContain('"text":"9月存入"');
  });

  it("uses December as the prior-month label in January", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({
      intent: "transactions",
      transactions: [{ type: "contribution", amount: 300, date: "2026-12-31", note: "十二月結餘" }],
    });
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("十二月存入300", {
      eventId: "december-carryover",
      userId: "SPOUSE_A",
      timestamp: Date.UTC(2026, 11, 31, 12),
    }), providers.env);
    await worker.fetch(await signedLineRequest("餘額", {
      eventId: "january-balance",
      timestamp: Date.UTC(2027, 0, 2, 12),
    }), providers.env);

    expect(providers.replies.at(-1)?.text).toContain("12月餘額：NT$300");
    expect(providers.replies.at(-1)?.text).toContain("1月存入：");
  });

  it("groups monthly details by newest date while preserving input order within each day", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({
      intent: "transactions",
      transactions: [
        { type: "expense", amount: 100, date: "2026-08-04", majorCategory: "飲食", smallCategory: "早餐", note: "蛋餅" },
        { type: "expense", amount: 200, date: "2026-08-06", majorCategory: "飲食", smallCategory: "午餐", note: "便當" },
        { type: "expense", amount: 300, date: "2026-08-06", majorCategory: "飲食", smallCategory: "晚餐", note: "牛肉麵" },
      ],
    });
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("多筆交易", { eventId: "grouped-details", timestamp: Date.UTC(2026, 7, 6, 12) }), providers.env);
    await worker.fetch(await signedLineRequest("本月明細", { eventId: "grouped-details-query", timestamp: Date.UTC(2026, 7, 6, 12) }), providers.env);

    const reply = providers.replies.at(-1);
    const text = reply?.text ?? "";
    expect(text.indexOf("#2 2026-08-06")).toBeLessThan(text.indexOf("#3 2026-08-06"));
    expect(text.indexOf("#3 2026-08-06")).toBeLessThan(text.indexOf("#1 2026-08-04"));
    const flex = JSON.stringify(reply?.flex);
    expect(flex).toContain('"text":"2026-08-06"');
    expect(flex).toContain('"text":"2026-08-04"');
    expect(flex.indexOf("#2 飲食／午餐")).toBeLessThan(flex.indexOf("#3 飲食／晚餐"));
    expect(flex).toContain('"color":"#D32F2F"');
    expect(flex).toContain("記錄者：成員甲");
  });

  it("paginates monthly details at ten entries", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({
      intent: "transactions",
      transactions: Array.from({ length: 11 }, (_, index) => ({
        type: "expense" as const,
        amount: 100 + index,
        date: "2026-08-04",
        majorCategory: "飲食",
        smallCategory: "午餐",
        note: `便當 ${index + 1}`,
      })),
    });
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("十一筆交易", { eventId: "pagination-create" }), providers.env);
    await worker.fetch(await signedLineRequest("本月明細", { eventId: "pagination-page-1" }), providers.env);
    const firstPage = JSON.stringify(providers.replies.at(-1)?.flex);
    expect(firstPage).toContain("action=page&view=%E6%9C%AC%E6%9C%88%E6%98%8E%E7%B4%B0&page=2");
    expect(firstPage).toContain("便當 10");
    expect(firstPage).not.toContain("便當 11");

    await worker.fetch(await signedLineRequest("本月明細 第2頁", { eventId: "pagination-page-2" }), providers.env);
    expect(JSON.stringify(providers.replies.at(-1)?.flex)).toContain("便當 11");
  });

  it("counts a confirmed high-value deposit toward the monthly contribution status", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push(
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
    expect(balanceReply).toContain("成員甲：NT$20,000");
    expect(balanceReply).toContain("成員乙：NT$0");
    expect(balanceReply).not.toContain("本月存入未完成");
  });

  it("shows existing and proposed amounts before handling a duplicate contribution", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("存入8000", { eventId: "first-contribution" }), providers.env);
    await worker.fetch(await signedLineRequest("存入9000", { eventId: "duplicate-contribution" }), providers.env);

    const reply = providers.replies.at(-1);
    expect(reply?.text).toContain("本月已有存入紀錄：NT$8,000");
    expect(reply?.text).toContain("本次存入：NT$9,000");
    const flex = JSON.stringify(reply?.flex);
    expect(flex).toContain("原存入金額");
    expect(flex).toContain("本次存入金額");
    expect(flex).toContain('"label":"修改原申報"');
    expect(flex).toContain('"label":"額外補入"');
    expect(flex).toContain('"displayText":"額外補入"');
    expect(flex).not.toMatch(/"displayText":"[^"]*[0-9a-f]{8}-[0-9a-f-]{27,}/);
    expect(providers.geminiInputs).toEqual([]);
  });

  it("records an explicit top-up without completing the monthly contribution", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("補入8000", {
      eventId: "explicit-topup",
      userId: "SPOUSE_A",
      timestamp: Date.UTC(2026, 9, 1, 11),
    }), providers.env);

    expect(providers.geminiInputs).toEqual([]);
    expect(store.states.get("GROUP")?.ledger[0]?.type).toBe("topup");
    expect(store.states.get("GROUP")?.months["2026-10"]?.confirmations.SPOUSE_A).toBeUndefined();
  });

  it("shows an expense total for a multi-expense receipt", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({
      intent: "transactions",
      transactions: [
        { type: "expense", amount: 1796, date: "2026-08-20", majorCategory: "生活", smallCategory: "水電瓦斯", note: "電費" },
        { type: "expense", amount: 225, date: "2026-08-20", majorCategory: "生活", smallCategory: "水電瓦斯", note: "水費" },
        { type: "expense", amount: 1108, date: "2026-08-20", majorCategory: "生活", smallCategory: "水電瓦斯", note: "瓦斯費" },
      ],
    });
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("電費1796\n水費225\n瓦斯費1108", { eventId: "multi-expense", timestamp: Date.UTC(2026, 7, 20, 12) }), providers.env);

    expect(providers.replies.at(-1)?.text).toContain("本次支出總額：NT$3,129");
    expect(JSON.stringify(providers.replies.at(-1)?.flex)).toContain("本次支出總額：NT$3,129");
  });

  it("rejects a batch that mixes contributions and expenses", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({
      intent: "transactions",
      transactions: [
        { type: "contribution", amount: 2000, date: "2026-08-20" },
        { type: "expense", amount: 300, date: "2026-08-20", majorCategory: "飲食", smallCategory: "晚餐", note: "晚餐" },
      ],
    });
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("存入2000\n晚餐300", { eventId: "mixed-batch", timestamp: Date.UTC(2026, 7, 20, 12) }), providers.env);

    expect(providers.replies.at(-1)?.text).toBe("請將存入與支出分開輸入，以免帳務紀錄錯誤。");
    expect(store.states.get("GROUP")?.ledger).toHaveLength(0);
  });

  it("shows the cached LINE display name as the recorder of every transaction", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push(
      { intent: "transactions", transactions: [{ type: "expense", amount: 300, date: "2026-08-04", majorCategory: "飲食", smallCategory: "晚餐", note: "牛肉麵" }] },
    );
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("存入8000", { eventId: "named-a", userId: "SPOUSE_A" }), providers.env);
    await worker.fetch(await signedLineRequest("晚餐牛肉麵300", { eventId: "named-b", userId: "SPOUSE_B" }), providers.env);
    await worker.fetch(await signedLineRequest("最近紀錄", { eventId: "named-recent", userId: "SPOUSE_A" }), providers.env);

    const recent = providers.replies.at(-1)?.text ?? "";
    expect(recent).toContain("記錄者：成員甲");
    expect(recent).toContain("記錄者：成員乙");
    expect(providers.memberNameCalls).toEqual([
      { groupId: "GROUP", userId: "SPOUSE_A" },
      { groupId: "GROUP", userId: "SPOUSE_B" },
    ]);
  });
});
