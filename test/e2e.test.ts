import { describe, expect, it } from "vitest";
import { createWorker } from "../src/app";
import { MemoryStore, TestProviders, signedLineRequest } from "./support";

describe("shared fund end-to-end lifecycle", () => {
  it("runs contributions, spending, high-value confirmation, month close, carryover, and CSV download", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.env.PUBLIC_BASE_URL = "https://example.test";
    providers.env.CHART_SIGNING_SECRET = "e2e-signing-secret";
    providers.parses.push(
      { intent: "transactions", transactions: [{ type: "contribution", amount: 5000, date: "2026-07-01" }] },
      { intent: "transactions", transactions: [{ type: "contribution", amount: 5000, date: "2026-07-01" }] },
      { intent: "transactions", transactions: [{ type: "expense", amount: 1200, date: "2026-07-20", majorCategory: "飲食", smallCategory: "晚餐", note: "聚餐" }] },
      { intent: "transactions", transactions: [{ type: "expense", amount: 12000, date: "2026-07-25", majorCategory: "購物", smallCategory: "家電", note: "冷氣" }] },
    );
    const worker = createWorker({ store, providers });
    const julyFirst = Date.UTC(2026, 6, 1, 2);

    await worker.fetch(await signedLineRequest("七月存入5000", { eventId: "e2e-fund-a", userId: "SPOUSE_A", timestamp: julyFirst }), providers.env);
    await worker.fetch(await signedLineRequest("七月存入5000", { eventId: "e2e-fund-b", userId: "SPOUSE_B", timestamp: julyFirst }), providers.env);
    await worker.fetch(await signedLineRequest("7/20 晚餐聚餐1200", { eventId: "e2e-expense", timestamp: Date.UTC(2026, 6, 20, 12) }), providers.env);
    await worker.fetch(await signedLineRequest("7/25 冷氣12000", { eventId: "e2e-high", timestamp: Date.UTC(2026, 6, 25, 12) }), providers.env);
    const confirmation = JSON.stringify(providers.replies.at(-1)?.flex).match(/action=confirm&id=([\w-]+)/)?.[1];
    expect(confirmation).toBeTruthy();
    await worker.fetch(await signedLineRequest(`確認 ${confirmation}`, { eventId: "e2e-high-confirm", timestamp: Date.UTC(2026, 6, 25, 12, 1) }), providers.env);

    await worker.scheduled?.({ scheduledTime: Date.UTC(2026, 6, 31, 16, 10), cron: "10 16 28-31 * *", noRetry() {} } as ScheduledEvent, providers.env);
    expect(providers.pushes.at(-1)?.text).toContain("月底結餘：-NT$3,200");
    expect(providers.pushes.at(-1)?.text).toContain("下月期初結轉：-NT$3,200");

    await worker.fetch(await signedLineRequest("餘額", { eventId: "e2e-august-balance", timestamp: Date.UTC(2026, 7, 1, 2) }), providers.env);
    expect(providers.replies.at(-1)?.text).toContain("-NT$3,200");

    await worker.fetch(await signedLineRequest("下載 CSV", { eventId: "e2e-csv", timestamp: Date.UTC(2026, 6, 31, 15) }), providers.env);
    const link = providers.replies.at(-1)?.text.match(/https:\/\/\S+/)?.[0];
    const csvResponse = await worker.fetch(new Request(link!), providers.env);
    const csv = await csvResponse.text();
    expect(csvResponse.status).toBe(200);
    expect(csv).toContain("聚餐");
    expect(csv).toContain("冷氣");
  });
});
