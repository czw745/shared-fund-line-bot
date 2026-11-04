import { describe, expect, it } from "vitest";
import { createWorker } from "../src/app";
import { validFlexContainer } from "../src/flex-validation";
import { MemoryStore, TestProviders, signedLineRequest, signedWebhookEvent } from "./support";

describe("safety and lifecycle workflows", () => {
  it("never exposes LINE user IDs through replies, Flex, pushes, or CSV", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    const userA = "Ua111111111111111111111111111111";
    const userB = "Ub222222222222222222222222222222";
    providers.env.ALLOWED_USER_IDS = `${userA},${userB}`;
    providers.env.PUBLIC_BASE_URL = "https://example.test";
    providers.env.CHART_SIGNING_SECRET = "csv-test-secret";
    providers.memberName = async () => { throw new Error("LINE Profile unavailable"); };
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 180, date: "2026-08-04", majorCategory: "飲食", smallCategory: "午餐", note: "便當" }] });
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("午餐便當180", { eventId: "privacy-expense", userId: userA }), providers.env);
    await worker.fetch(await signedLineRequest("餘額", { eventId: "privacy-balance", userId: userA }), providers.env);
    await worker.fetch(await signedLineRequest("最近紀錄", { eventId: "privacy-recent", userId: userA }), providers.env);
    await worker.fetch(await signedLineRequest("修改", { eventId: "privacy-manage", userId: userA }), providers.env);
    await worker.fetch(await signedLineRequest("下載 CSV", { eventId: "privacy-csv", userId: userA }), providers.env);
    await worker.scheduled?.({ scheduledTime: Date.UTC(2026, 7, 3, 1), cron: "0 1 1,3 * *", noRetry() {} } as ScheduledEvent, providers.env);

    const visibleMessages = JSON.stringify([...providers.replies, ...providers.pushes]);
    expect(visibleMessages).not.toContain(userA);
    expect(visibleMessages).not.toContain(userB);
    const link = providers.replies.find((reply) => reply.text.includes("CSV 已產生"))?.text.match(/https:\/\/\S+/)?.[0];
    expect(link).toBeTruthy();
    const csv = await (await worker.fetch(new Request(link!), providers.env)).text();
    expect(csv).not.toContain(userA);
    expect(csv).not.toContain(userB);
  });

  it("downloads the current month CSV through a signed short-lived link", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.env.PUBLIC_BASE_URL = "https://example.test";
    providers.env.CHART_SIGNING_SECRET = "csv-test-secret";
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 180, date: "2026-08-04", majorCategory: "飲食", smallCategory: "午餐", note: "便當" }] });
    const worker = createWorker({ store, providers });
    await worker.fetch(await signedLineRequest("午餐便當180", { eventId: "csv-entry" }), providers.env);
    await worker.fetch(await signedLineRequest("下載 CSV", { eventId: "csv-download" }), providers.env);

    const link = providers.replies.at(-1)?.text.match(/https:\/\/\S+/)?.[0];
    expect(link).toBeTruthy();
    const download = await worker.fetch(new Request(link!), providers.env);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("text/csv");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    const csv = await download.text();
    expect(csv).toContain("便當");
    expect(csv).toContain("午餐");
    expect(csv).toContain("建立者名稱");
    expect(csv).not.toContain("建立者ID");
    expect(csv).not.toMatch(/SPOUSE_|U[0-9a-f]{8,}/i);

    const tampered = new URL(link!);
    tampered.searchParams.set("signature", "invalid");
    expect((await worker.fetch(new Request(tampered), providers.env)).status).toBe(404);
  });

  it("opens recent records, monthly details, and transaction management from one 明細 menu", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("明細", { eventId: "detail-menu" }), providers.env);
    const menu = JSON.stringify(providers.replies.at(-1)?.flex);
    expect(menu).toContain('"label":"最近紀錄"');
    expect(menu).toContain('"label":"本月明細"');
    expect(menu).toContain('"label":"修改交易"');
    expect(menu).toContain("action=detail&value=%E6%9C%80%E8%BF%91%E7%B4%80%E9%8C%84");
    expect(providers.geminiInputs).toHaveLength(0);

    await worker.fetch(await signedWebhookEvent({
      type: "postback", webhookEventId: "detail-menu-recent", timestamp: Date.UTC(2026, 7, 4, 4), replyToken: "detail-menu-reply",
      source: { type: "group", groupId: "GROUP", userId: "SPOUSE_A" },
      postback: { data: "action=detail&value=%E6%9C%80%E8%BF%91%E7%B4%80%E9%8C%84" },
    }), providers.env);
    expect(providers.replies.at(-1)?.text).toBe("目前沒有交易紀錄。");
  });

  it("replaces an edited transaction only after confirmation", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 600, date: "2026-08-04", majorCategory: "飲食", smallCategory: "晚餐", note: "晚餐牛肉麵" }] });
    const worker = createWorker({ store, providers });
    await worker.fetch(await signedLineRequest("晚餐牛肉麵600", { eventId: "edit-create" }), providers.env);
    await worker.fetch(await signedLineRequest("修改", { eventId: "edit-list" }), providers.env);
    const transactionId = JSON.stringify(providers.replies.at(-1)?.flex).match(/action=edit&id=([\w-]+)/)?.[1];
    expect(transactionId).toBeTruthy();

    await worker.fetch(await signedLineRequest(`編輯 ${transactionId}`, { eventId: "edit-open" }), providers.env);
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 700, date: "2026-08-04", majorCategory: "飲食", smallCategory: "晚餐", note: "晚餐牛肉麵" }] });
    await worker.fetch(await signedLineRequest("8/4 晚餐牛肉麵 700", { eventId: "edit-describe" }), providers.env);
    const confirmationId = JSON.stringify(providers.replies.at(-1)?.flex).match(/action=confirm&id=([\w-]+)/)?.[1];
    expect(confirmationId).toBeTruthy();
    await worker.fetch(await signedLineRequest(`確認 ${confirmationId}`, { eventId: "edit-confirm" }), providers.env);
    await worker.fetch(await signedLineRequest("最近紀錄", { eventId: "edit-recent" }), providers.env);

    const recent = providers.replies.at(-1)?.text ?? "";
    expect(recent).toContain("支出 NT$700");
    expect(recent).not.toContain("支出 NT$600");
  });

  it("copies only the selected transaction from a batch", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({
      intent: "transactions",
      transactions: [
        { type: "expense", amount: 1600, date: "2026-08-01", majorCategory: "購物", smallCategory: "家電", note: "電扇" },
        { type: "expense", amount: 800, date: "2026-08-02", majorCategory: "購物", smallCategory: "家電", note: "檯燈" },
      ],
    });
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("8/1 電扇1600\n8/2 檯燈800", { eventId: "batch-copy" }), providers.env);
    await worker.fetch(await signedLineRequest("修改", { eventId: "batch-manage" }), providers.env);

    const flexJson = JSON.stringify(providers.replies.at(-1)?.flex);
    expect(flexJson).toContain('"label":"複製"');
    expect(flexJson).toContain('"clipboardText":"8/1 家電 電扇 1600"');
    expect(flexJson).toContain('"clipboardText":"8/2 家電 檯燈 800"');
    expect(flexJson).not.toContain('"clipboardText":"8/1 電扇1600\\n8/2 檯燈800"');
  });

  it("holds a high-value transaction for same-sender confirmation", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 12000, date: "2026-08-04", majorCategory: "購物", smallCategory: "家電", note: "冰箱" }] });
    const worker = createWorker({ store, providers });
    await worker.fetch(await signedLineRequest("冰箱12000", { eventId: "large" }), providers.env);
    const confirmation = JSON.stringify(providers.replies.at(-1)?.flex).match(/action=confirm&id=([\w-]+)/)?.[1];
    expect(confirmation).toBeTruthy();
    expect(JSON.stringify(providers.replies.at(-1)?.flex)).toContain("高額交易，請再次確認");

    await worker.fetch(await signedLineRequest(`確認 ${confirmation}`, { eventId: "wrong", userId: "SPOUSE_B" }), providers.env);
    await worker.fetch(await signedLineRequest("餘額", { eventId: "before" }), providers.env);
    expect(providers.replies.at(-1)?.text).toContain("NT$0");

    await worker.fetch(await signedLineRequest(`確認 ${confirmation}`, { eventId: "right", userId: "SPOUSE_A" }), providers.env);
    await worker.fetch(await signedLineRequest("餘額", { eventId: "after" }), providers.env);
    expect(providers.replies.at(-1)?.text).toContain("-NT$12,000");
  });

  it("edits only the sender's transactions and rejects removed refund operations", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 800, date: "2026-08-04", majorCategory: "娛樂", smallCategory: "聚會", note: "聚餐" }] });
    const worker = createWorker({ store, providers });
    await worker.fetch(await signedLineRequest("聚餐800", { eventId: "meal" }), providers.env);
    await worker.fetch(await signedLineRequest("修改", { eventId: "manage" }), providers.env);
    const managementReply = providers.replies.at(-1);
    const flexJson = JSON.stringify(managementReply?.flex);
    const transactionId = flexJson.match(/action=edit&id=([\w-]+)/)?.[1];
    expect(transactionId).toBeTruthy();
    expect(managementReply?.text).not.toContain("ID:");
    expect(managementReply?.text).toContain("娛樂／聚會");
    expect(flexJson).not.toContain("action=refund");
    expect(flexJson).toContain('"type":"clipboard"');
    expect(flexJson).toContain('"label":"複製"');
    expect(flexJson).toContain('"clipboardText":"8/4 聚會 聚餐 800"');
    expect(flexJson).toContain('"backgroundColor":"#F7F8FA"');
    expect(flexJson).toContain('"text":"支出｜娛樂／聚會"');
    expect(flexJson).toContain('"label":"刪除","data"');
    expect(flexJson).toContain('"color":"#D32F2F"');

    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 500, date: "2026-08-04", majorCategory: "娛樂", smallCategory: "聚會", note: "改後聚餐" }] });
    await worker.fetch(await signedLineRequest(`編輯 ${transactionId}`, { eventId: "edit-start" }), providers.env);
    await worker.fetch(await signedLineRequest("改後聚餐500", { eventId: "edit-proposal" }), providers.env);
    const candidateReply = providers.replies.at(-1);
    const candidateFlex = JSON.stringify(candidateReply?.flex);
    const candidateId = candidateFlex.match(/action=cancel&id=([\w-]+)/)?.[1];
    expect(candidateId).toBeTruthy();
    expect(candidateReply?.text).toContain("修改前");
    expect(candidateReply?.text).toContain("修改後");
    expect(candidateFlex).toContain('"label":"確認修改"');
    expect(candidateFlex).toContain('"label":"取消修改"');
    expect(candidateFlex).toContain('"text":"確認交易修改"');
    expect(candidateFlex).toContain('"backgroundColor":"#F2F3F5"');
    expect(candidateFlex).toContain('"backgroundColor":"#EAF5EC"');
    expect(candidateFlex).toContain('"style":"primary"');

    await worker.fetch(await signedLineRequest(`取消 ${candidateId}`, { eventId: "edit-cancel" }), providers.env);
    expect(providers.replies.at(-1)?.text).toBe("已取消修改，原交易保持不變。");

    providers.parses.push({ intent: "transactions", transactions: [{ type: "refund", amount: 300, date: "2026-08-04", linkedTransactionId: transactionId! }] });
    await worker.fetch(await signedLineRequest(`退款 ${transactionId} 300`, { eventId: "removed-refund" }), providers.env);
    expect(providers.replies.at(-1)?.text).toContain("交易欄位不完整或無效，尚未入帳");
    await worker.fetch(await signedLineRequest("餘額", { eventId: "unchanged-balance" }), providers.env);
    expect(providers.replies.at(-1)?.text).toContain("-NT$800");
  });

  it("continues an ambiguous edit from category selection to confirmation without exposing internal IDs", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({ intent: "transactions", transactions: [{ type: "expense", amount: 600, date: "2026-08-04", majorCategory: "飲食", smallCategory: "晚餐", note: "牛肉麵" }] });
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("8/4 晚餐牛肉麵600", { eventId: "category-create" }), providers.env);
    await worker.fetch(await signedLineRequest("修改", { eventId: "category-manage" }), providers.env);
    const managementFlex = JSON.stringify(providers.replies.at(-1)?.flex);
    const transactionId = managementFlex.match(/action=edit&id=([\w-]+)/)?.[1];
    expect(transactionId).toBeTruthy();
    expect(managementFlex).toContain('"clipboardText":"8/4 晚餐 牛肉麵 600"');

    await worker.fetch(await signedLineRequest(`編輯 ${transactionId}`, { eventId: "category-edit" }), providers.env);
    providers.parses.push({
      intent: "transactions",
      transactions: [{ type: "expense", amount: 1100, date: "2026-08-04", majorCategory: "飲食", note: "牛肉麵" }],
      ambiguous: true,
      categoryChoices: ["早餐", "午餐", "晚餐"],
    });
    await worker.fetch(await signedLineRequest("8/4 牛肉麵 1100", { eventId: "category-proposal" }), providers.env);
    const choiceReply = providers.replies.at(-1);
    const choiceFlex = JSON.stringify(choiceReply?.flex);
    const candidateId = choiceFlex.match(/action=category&id=([\w-]+)&value=%E6%99%9A%E9%A4%90/)?.[1];
    expect(candidateId).toBeTruthy();
    expect(choiceReply?.text).not.toContain("undefined");
    expect(choiceFlex).toContain('"displayText":"第 1 筆選擇分類：飲食／晚餐"');

    await worker.fetch(await signedLineRequest(`分類 ${candidateId} 晚餐`, { eventId: "category-select" }), providers.env);
    const confirmReply = providers.replies.at(-1);
    const confirmFlex = JSON.stringify(confirmReply?.flex);
    expect(confirmReply?.text).toContain("飲食／晚餐");
    expect(confirmReply?.text).not.toContain(candidateId);
    expect(confirmFlex).toContain('"label":"確認修改"');
    expect(confirmFlex).toContain('"label":"取消修改"');
  });

  it("highlights only the unresolved item before showing the full batch confirmation", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push({
      intent: "transactions",
      ambiguous: true,
      categoryChoices: ["日用品", "零食", "午餐"],
      transactions: [
        { type: "expense", amount: 120, date: "2026-08-10", majorCategory: "交通", smallCategory: "計程車", note: "叫車" },
        { type: "expense", amount: 70, date: "2026-08-11", majorCategory: "生活", smallCategory: "停車費" },
        { type: "expense", amount: 130, date: "2026-08-11", majorCategory: "生活", smallCategory: "停車費" },
        { type: "expense", amount: 260, date: "2026-08-12", majorCategory: "交通", smallCategory: "計程車", note: "叫車" },
        { type: "expense", amount: 80, date: "2026-08-12", majorCategory: "生活", smallCategory: "停車費" },
        { type: "expense", amount: 150, date: "2026-08-12", note: "雜貨" },
      ],
    });
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("8/10 叫車 120\n8/11 停車 70\n停車 130\n8/12 叫車 260\n停車 80\n雜貨 150", {
      eventId: "ambiguous-batch",
      userId: "SPOUSE_B",
      timestamp: Date.UTC(2026, 7, 12, 12),
    }), providers.env);

    const choiceReply = providers.replies.at(-1);
    const choiceFlex = JSON.stringify(choiceReply?.flex);
    const candidateId = choiceFlex.match(/action=category&id=([\w-]+)&value=%E6%97%A5%E7%94%A8%E5%93%81/)?.[1];
    expect(candidateId).toBeTruthy();
    expect(validFlexContainer(choiceReply?.flex)).toBe(true);
    expect(choiceReply?.text).toContain("第 6 筆需要分類：雜貨 NT$150");
    expect(choiceReply?.text).toContain("其餘 5 筆已辨識完成");
    expect(choiceFlex).toContain("需要分類：第 6 筆");
    expect(choiceFlex).toContain('"label":"購物／日用品"');
    expect(choiceFlex).not.toContain("待入帳 1");
    expect(choiceFlex).not.toContain("action=confirm");

    await worker.fetch(await signedLineRequest(`分類 ${candidateId} 日用品`, {
      eventId: "ambiguous-batch-category",
      userId: "SPOUSE_B",
      timestamp: Date.UTC(2026, 7, 12, 12, 1),
    }), providers.env);

    const confirmation = providers.replies.at(-1);
    const confirmationFlex = JSON.stringify(confirmation?.flex);
    expect(validFlexContainer(confirmation?.flex)).toBe(true);
    expect(confirmation?.text).toContain("購物／日用品");
    expect(confirmationFlex).toContain("待入帳 1");
    expect(confirmationFlex).toContain("待入帳 6");
    expect(confirmationFlex).toContain('"label":"確認入帳"');
  });

  it("shares a learned category correction with both members without another Gemini call", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    providers.parses.push(
      { intent: "transactions", transactions: [{ type: "expense", amount: 400, date: "2026-08-04", majorCategory: "娛樂", smallCategory: "聚會", note: "風倍清" }] },
      { intent: "transactions", transactions: [{ type: "expense", amount: 400, date: "2026-08-04", majorCategory: "購物", smallCategory: "日用品", note: "風倍清" }] },
    );
    const worker = createWorker({ store, providers });

    await worker.fetch(await signedLineRequest("風倍清400", { eventId: "learn-create", userId: "SPOUSE_A" }), providers.env);
    await worker.fetch(await signedLineRequest("修改", { eventId: "learn-list", userId: "SPOUSE_A" }), providers.env);
    const transactionId = JSON.stringify(providers.replies.at(-1)?.flex).match(/action=edit&id=([\w-]+)/)?.[1];
    await worker.fetch(await signedLineRequest(`編輯 ${transactionId}`, { eventId: "learn-edit", userId: "SPOUSE_A" }), providers.env);
    await worker.fetch(await signedLineRequest("日用品 風倍清 400", { eventId: "learn-replacement", userId: "SPOUSE_A" }), providers.env);
    const confirmationId = JSON.stringify(providers.replies.at(-1)?.flex).match(/action=confirm&id=([\w-]+)/)?.[1];
    await worker.fetch(await signedLineRequest(`確認 ${confirmationId}`, { eventId: "learn-confirm", userId: "SPOUSE_A" }), providers.env);

    await worker.fetch(await signedLineRequest("風倍清 2瓶 500", { eventId: "learn-reuse", userId: "SPOUSE_B" }), providers.env);

    const reply = providers.replies.at(-1)?.text ?? "";
    expect(reply).toContain("購物／日用品");
    expect(reply).toContain("NT$500");
    expect(providers.geminiInputs).toEqual(["風倍清400", "日用品 風倍清 400"]);
    expect(store.states.get("GROUP")?.categoryRules).toEqual(expect.arrayContaining([expect.objectContaining({ keyword: "風倍清", majorCategory: "購物", smallCategory: "日用品" })]));
  });
});
