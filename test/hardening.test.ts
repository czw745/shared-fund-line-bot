import { describe, expect, it } from "vitest";
import { createWorker } from "../src/app";
import { MemoryStore, TestProviders, signedLineRequest, signedWebhookEvent } from "./support";

describe("privacy and accounting hardening", () => {
  it("does not hold the group lock while Gemini parses a transaction", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    const worker = createWorker({ store, providers });
    let releaseParse!: () => void;
    let markParseStarted!: () => void;
    const parseGate = new Promise<void>((resolve) => { releaseParse = resolve; });
    const parseStarted = new Promise<void>((resolve) => { markParseStarted = resolve; });
    providers.parse = async () => {
      markParseStarted();
      await parseGate;
      return { intent: "transactions", transactions: [{ type: "expense", amount: 300, date: "2026-08-04", majorCategory: "飲食", smallCategory: "晚餐" }] };
    };

    const first = worker.fetch(await signedLineRequest("晚餐300", { eventId: "slow-gemini" }), providers.env);
    await parseStarted;
    const second = worker.fetch(await signedLineRequest("餘額", { eventId: "during-gemini" }), providers.env);
    const secondResult = await Promise.race([
      second.then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    releaseParse();
    await first;

    expect(secondResult).toBe("completed");
  });

  it("does not hold the group lock while LINE quota status is loading", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    const worker = createWorker({ store, providers });
    let releaseQuota!: () => void;
    let markQuotaStarted!: () => void;
    const quotaGate = new Promise<void>((resolve) => { releaseQuota = resolve; });
    const quotaStarted = new Promise<void>((resolve) => { markQuotaStarted = resolve; });
    providers.pushAllowance = async () => {
      markQuotaStarted();
      await quotaGate;
      return 200;
    };

    const first = worker.fetch(await signedLineRequest("系統狀態", { eventId: "slow-quota" }), providers.env);
    await quotaStarted;
    const second = worker.fetch(await signedLineRequest("餘額", { eventId: "during-quota" }), providers.env);
    const secondResult = await Promise.race([
      second.then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    releaseQuota();
    await first;

    expect(secondResult).toBe("completed");
  });

  it("releases the group lock before waiting for LINE reply", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    const worker = createWorker({ store, providers });
    let releaseFirstReply!: () => void;
    let markFirstReplyStarted!: () => void;
    const firstReplyGate = new Promise<void>((resolve) => { releaseFirstReply = resolve; });
    const firstReplyStarted = new Promise<void>((resolve) => { markFirstReplyStarted = resolve; });
    let replyCount = 0;
    providers.reply = async (token, message) => {
      replyCount += 1;
      if (replyCount === 1) {
        markFirstReplyStarted();
        await firstReplyGate;
      }
      providers.replies.push({ ...message, token });
    };

    const first = worker.fetch(await signedLineRequest("說明", { eventId: "slow-reply" }), providers.env);
    await firstReplyStarted;
    const second = worker.fetch(await signedLineRequest("餘額", { eventId: "fast-followup" }), providers.env);
    const secondResult = await Promise.race([
      second.then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    releaseFirstReply();
    await first;

    expect(secondResult).toBe("completed");
    expect(providers.replies.some((reply) => reply.text.includes("餘額"))).toBe(true);
  });

  it("stores a failed postback reply and includes it in the next interaction", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    const worker = createWorker({ store, providers });
    let failNextReply = true;
    providers.reply = async (token, message) => {
      if (failNextReply) {
        failNextReply = false;
        throw new Error("LINE unavailable");
      }
      providers.replies.push({ ...message, token });
    };

    await worker.fetch(await signedWebhookEvent({
      type: "postback", webhookEventId: "failed-postback-reply", timestamp: Date.UTC(2026, 7, 4, 4), replyToken: "failed-postback-token",
      source: { type: "group", groupId: "GROUP", userId: "SPOUSE_A" },
      postback: { data: "action=menu&value=%E6%98%8E%E7%B4%B0" },
    }), providers.env);
    await worker.fetch(await signedLineRequest("餘額", { eventId: "recover-postback-reply" }), providers.env);

    expect(providers.replies.at(-1)?.text).toContain("請選擇明細功能");
    expect(providers.replies.at(-1)?.text).toContain("餘額");
    expect(store.events.find((event) => event.id === "failed-postback-reply")?.status).toBe("posted");
    expect(store.events.find((event) => event.id === "failed-postback-reply")?.errorCode).toBeUndefined();
    expect((await store.errorSummary("GROUP", 0)).total).toBe(0);
  });

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
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 300, date: "2026-08-04", majorCategory: "飲食", smallCategory: "晚餐" }] });
    await worker.fetch(await signedLineRequest("晚餐300", { eventId: "resumed" }), providers.env);
    expect(providers.geminiInputs).toEqual(["晚餐300"]);
  });

  it("retries an AI failure without posting twice", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parseFailures = 1;
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 300, date: "2026-08-04", majorCategory: "飲食", smallCategory: "晚餐", note: "晚餐" }] });
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
