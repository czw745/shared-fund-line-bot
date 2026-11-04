import { describe, expect, it } from "vitest";
import { createWorker } from "../src/app";
import { MemoryStore, TestProviders, signedLineRequest, signedWebhookEvent } from "./support";

describe("LINE Worker handler", () => {
  it("acknowledges the webhook before background Gemini parsing finishes", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    const worker = createWorker({ store, providers });
    let releaseParse!: () => void;
    const parseGate = new Promise<void>((resolve) => { releaseParse = resolve; });
    providers.parse = async () => {
      await parseGate;
      return { intent: "zero_contribution" };
    };
    const background: Promise<unknown>[] = [];
    const context = { waitUntil(promise: Promise<unknown>) { background.push(promise); } };

    const response = await worker.fetch(await signedLineRequest("本月不存"), providers.env, context);

    expect(response.status).toBe(200);
    expect(background).toHaveLength(1);
    expect(providers.replies).toHaveLength(0);
    releaseParse();
    await Promise.all(background);
    expect(providers.replies).toHaveLength(1);
    expect(providers.replies[0]?.text).toContain("餘額（本月存入未完成）");
  });

  it("answers help for an authenticated spouse exactly once", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    const worker = createWorker({ store, providers });
    const request = await signedLineRequest("說明", { eventId: "evt-1" });

    expect((await worker.fetch(request, providers.env)).status).toBe(200);
    expect(providers.replies.at(-1)?.text).toContain("餘額");
    const menu = JSON.stringify(providers.replies.at(-1)?.flex);
    expect(menu).toContain('"label":"餘額"');
    expect(menu).toContain('"label":"明細"');
    expect(menu).toContain('"label":"圖表"');
    expect(menu).toContain('"label":"系統狀態"');
    expect(menu).toContain("action=menu&value=%E6%98%8E%E7%B4%B0");
    expect(providers.geminiInputs).toHaveLength(0);

    const replay = await signedLineRequest("說明", { eventId: "evt-1" });
    expect((await worker.fetch(replay, providers.env)).status).toBe(200);
    expect(providers.replies).toHaveLength(1);
    expect(store.events[0]?.raw).toBeUndefined();
  });

  it("reports Gemini and LINE Push usage from the help menu", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.allowance = 173;
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedWebhookEvent({
      type: "postback", webhookEventId: "help-status", timestamp: Date.UTC(2026, 7, 4, 4), replyToken: "help-status-reply",
      source: { type: "group", groupId: "GROUP", userId: "SPOUSE_A" },
      postback: { data: "action=menu&value=%E7%B3%BB%E7%B5%B1%E7%8B%80%E6%85%8B" },
    }), providers.env);

    const status = providers.replies.at(-1)?.text ?? "";
    expect(status).toContain("Gemini 今日：0 / 100 次");
    expect(status).toContain("LINE Push 本月：已用 27、剩餘 173 / 200 則");
    expect(status).toContain("最近 24 小時：運作正常");
    expect(providers.geminiInputs).toHaveLength(0);
  });

  it("summarizes recent sanitized errors in system status", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    const worker = createWorker({ store, providers });
    const timestamp = Date.UTC(2026, 7, 5, 4);
    await store.beginEvent({ id: "failed-reply", groupId: "GROUP", userId: "SPOUSE_A", timestamp: timestamp - 1_000, status: "reply_pending" });
    await store.finishEvent("failed-reply", "reply_pending", "line_reply_failed");
    await store.beginEvent({ id: "old-timeout", groupId: "GROUP", userId: "SPOUSE_A", timestamp: timestamp - 25 * 60 * 60 * 1000, status: "failed_retryable" });
    await store.finishEvent("old-timeout", "failed_retryable", "external_timeout");
    await store.beginEvent({ id: "expected-rejection", groupId: "GROUP", userId: "SPOUSE_A", timestamp: timestamp - 500, status: "failed_final" });
    await store.finishEvent("expected-rejection", "failed_final", "invalid_command");

    await worker.fetch(await signedLineRequest("系統狀態", { eventId: "health-status", timestamp }), providers.env);

    const status = providers.replies.at(-1)?.text ?? "";
    expect(status).toContain("最近 24 小時：1 筆異常");
    expect(status).toContain("LINE 回覆失敗 1");
    expect(status).not.toContain("external_timeout");
    expect(status).not.toContain("其他錯誤");
    expect(status).not.toContain("SPOUSE_A");
  });

  it("opens the detail submenu from the help menu postback", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedWebhookEvent({
      type: "postback", webhookEventId: "help-detail", timestamp: Date.UTC(2026, 7, 4, 4), replyToken: "help-detail-reply",
      source: { type: "group", groupId: "GROUP", userId: "SPOUSE_A" },
      postback: { data: "action=menu&value=%E6%98%8E%E7%B4%B0" },
    }), providers.env);

    expect(providers.replies.at(-1)?.text).toContain("請選擇明細功能");
    expect(JSON.stringify(providers.replies.at(-1)?.flex)).toContain('"label":"最近紀錄"');
    expect(JSON.stringify(providers.replies.at(-1)?.flex)).toContain('"label":"下載 CSV"');
    expect(providers.geminiInputs).toHaveLength(0);
  });

  it("uses configured member name overrides before LINE Profile", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.env.MEMBER_NAME_OVERRIDES = JSON.stringify({ SPOUSE_A: "成員甲", SPOUSE_B: "成員乙" });
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 100, date: "2026-08-04", majorCategory: "飲食", smallCategory: "午餐", note: "便當" }] });
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("午餐便當100", { eventId: "override-entry" }), providers.env);
    await worker.fetch(await signedLineRequest("最近紀錄", { eventId: "override-recent" }), providers.env);

    expect(providers.replies.at(-1)?.text).toContain("記錄者：成員甲");
    expect(providers.memberNameCalls).toHaveLength(0);
  });

  it("ignores invalid signatures and unauthorized sources", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    const worker = createWorker({ store, providers });
    const invalid = await signedLineRequest("說明", { signature: "invalid" });
    const outsider = await signedLineRequest("說明", { userId: "OUTSIDER" });

    expect((await worker.fetch(invalid, providers.env)).status).toBe(401);
    expect((await worker.fetch(outsider, providers.env)).status).toBe(200);
    expect(providers.replies).toHaveLength(0);
    expect(store.events).toHaveLength(0);
  });
});
