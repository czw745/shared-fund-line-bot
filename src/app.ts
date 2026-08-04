import { validLineSignature } from "./security";
import { activeEntries, addEntry, balance, CATEGORIES, eventDate, money, monthOf, monthState, openingBalance, signedAmount, validTransaction } from "./domain";
import type { AppEnv, GroupState, LineEvent, LineWebhook, ParsedTransaction, Providers, ReplyMessage, Store, WorkerApp } from "./types";

const HELP = [
  "共同基金可用指令：",
  "餘額｜最近紀錄｜修改｜本月明細",
  "本月分析｜每月趨勢｜分類趨勢｜說明",
  "目前只支援文字記帳。",
].join("\n");

function allowedUsers(env: AppEnv): Set<string> {
  return new Set(env.ALLOWED_USER_IDS.split(",").map((value) => value.trim()).filter(Boolean));
}

function authorized(event: LineEvent, env: AppEnv): event is LineEvent & { source: { groupId: string; userId: string; type: "group" } } {
  const source = event.source;
  return Boolean(
    source &&
    source.type === "group" &&
    source.groupId === env.ALLOWED_GROUP_ID &&
    source.userId &&
    allowedUsers(env).has(source.userId),
  );
}

function receipt(transactions: ParsedTransaction[], state: GroupState, alert?: string): ReplyMessage {
  const lines = transactions.map((transaction) => {
    const category = transaction.majorCategory ? ` ${transaction.majorCategory}／${transaction.smallCategory}` : "";
    return `${transaction.date} ${transaction.type === "expense" ? "支出" : "存入"} ${money(transaction.amount)}${category}${transaction.note ? `｜${transaction.note}` : ""}`;
  });
  const currentMonth = monthState(state, monthOf(transactions[0]?.date ?? eventDate(Date.now())));
  const label = currentMonth.status === "active" ? "目前餘額" : "暫估餘額";
  const text = `${lines.join("\n")}\n${label}：${money(balance(state))}${alert ? `\n${alert}` : ""}`;
  return { text, flex: { type: "bubble", altText: text } };
}

function balanceBand(value: number): number {
  if (value >= 1000) return 3;
  if (value >= 500) return 2;
  if (value >= 0) return 1;
  return 0;
}

function crossingAlert(state: GroupState, month: string, before: number, after: number): string | undefined {
  const priorBand = state.thresholdBands[month] ?? balanceBand(before);
  const nextBand = balanceBand(after);
  state.thresholdBands[month] = nextBand;
  if (nextBand >= priorBand) return undefined;
  if (nextBand === 2) return "提醒：共同基金餘額已低於 NT$1,000。";
  if (nextBand === 1) return "提醒：共同基金餘額已低於 NT$500。";
  return `提醒：共同基金已為負數，至少需要補入 ${money(Math.abs(after))}。`;
}

function voidEntry(state: GroupState, target: ReturnType<typeof activeEntries>[number], event: { id: string; timestamp: number; originalText: string }): void {
  state.sequence += 1;
  state.ledger.push({ ...target, id: crypto.randomUUID(), sequence: state.sequence, status: "void", revisionOf: target.id, eventId: event.id, createdAt: event.timestamp, originalText: event.originalText });
  if (target.type === "contribution") {
    const fundMonth = monthState(state, monthOf(target.date));
    if (fundMonth.confirmations[target.actorId]?.entryId === target.id) {
      delete fundMonth.confirmations[target.actorId];
      if (fundMonth.status !== "closed") fundMonth.status = "awaiting_contributions";
      else fundMonth.incomplete = true;
    }
  }
}

function balanceReply(state: GroupState, timestamp: number): ReplyMessage {
  const month = monthState(state, monthOf(eventDate(timestamp)));
  const label = month.status === "active" ? "目前餘額" : "暫估餘額";
  const statuses = Object.entries(month.confirmations).map(([user, confirmation]) => `${user}:${money(confirmation.amount)}`).join("、") || "兩人皆未確認存入";
  return { text: `${label}：${money(balance(state))}\n本月存入：${statuses}` };
}

function categoryTotals(state: GroupState, month: string): number[] {
  const totals = new Map(Object.keys(CATEGORIES).map((category) => [category, 0]));
  for (const entry of activeEntries(state).filter((candidate) => monthOf(candidate.date) === month && (candidate.type === "expense" || candidate.type === "refund"))) {
    if (!entry.majorCategory || !totals.has(entry.majorCategory)) continue;
    const direction = entry.type === "expense" ? 1 : -1;
    totals.set(entry.majorCategory, (totals.get(entry.majorCategory) ?? 0) + direction * entry.amount);
  }
  return [...totals.values()];
}

async function chartReply(command: string, state: GroupState, timestamp: number, providers: Providers): Promise<ReplyMessage> {
  const current = monthOf(eventDate(timestamp));
  if (command === "本月分析") {
    const labels = Object.keys(CATEGORIES);
    const values = categoryTotals(state, current);
    const total = values.reduce((sum, value) => sum + value, 0);
    const summary = [`本月淨支出 ${money(total)}`];
    try {
      const url = await providers.chart("month", { labels, datasets: [{ label: "淨支出", values }], summary });
      return { text: summary.join("\n"), flex: chartFlex(url, summary) };
    } catch {
      return { text: `${summary.join("\n")}\n圖表暫時無法產生。` };
    }
  }
  const cursor = new Date(`${current}-01T00:00:00+08:00`);
  const months: string[] = [];
  for (let offset = 5; offset >= 0; offset -= 1) {
    const date = new Date(cursor);
    date.setUTCMonth(date.getUTCMonth() - offset);
    months.push(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).format(date));
  }
  if (command === "每月趨勢") {
    const contributions = months.map((month) => activeEntries(state).filter((entry) => monthOf(entry.date) === month && ["contribution", "topup", "income"].includes(entry.type)).reduce((sum, entry) => sum + entry.amount, 0));
    const expenses = months.map((month) => categoryTotals(state, month).reduce((sum, value) => sum + value, 0));
    const closings = months.map((month) => state.months[month]?.closingBalance ?? balance(state, `${month}-31`));
    const summary = [`最近 ${months.length} 個月支出 ${money(expenses.reduce((sum, value) => sum + value, 0))}`];
    try {
      const url = await providers.chart("monthly-trend", { labels: months, datasets: [{ label: "存入", values: contributions }, { label: "支出", values: expenses }, { label: "月底結餘", values: closings }], summary });
      return { text: summary.join("\n"), flex: chartFlex(url, summary) };
    } catch {
      return { text: `${summary.join("\n")}\n圖表暫時無法產生。` };
    }
  }
  const datasets = Object.keys(CATEGORIES).map((category, index) => ({ label: category, values: months.map((month) => categoryTotals(state, month)[index] ?? 0) }));
  const summary = ["最近六個月分類趨勢"];
  try {
    const url = await providers.chart("category-trend", { labels: months, datasets, summary });
    return { text: summary.join("\n"), flex: chartFlex(url, summary) };
  } catch {
    return { text: `${summary.join("\n")}\n圖表暫時無法產生。` };
  }
}

function chartFlex(url: string, summary: string[]): Record<string, unknown> {
  return {
    type: "bubble",
    hero: { type: "image", url, size: "full", aspectRatio: "3:2", aspectMode: "fit" },
    body: { type: "box", layout: "vertical", contents: summary.map((text) => ({ type: "text", text, wrap: true, size: "sm" })) },
  };
}

function csvForMonth(state: GroupState, month: string): string {
  const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const header = ["日期", "類型", "金額", "大分類", "小分類", "備註", "建立者", "輸入原文", "建立時間", "狀態", "關聯交易"];
  const rows = state.ledger.filter((entry) => monthOf(entry.date) === month).map((entry) => [entry.date, entry.type, entry.amount, entry.majorCategory, entry.smallCategory, entry.note, entry.actorId, entry.originalText, new Date(entry.createdAt).toISOString(), entry.status, entry.linkedTransactionId ?? entry.revisionOf]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(quote).join(",")).join("\r\n")}`;
}

async function uploadCsvWithRetry(providers: Providers, month: string, csv: string, existingFileId?: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await providers.uploadCsv(month, csv, existingFileId);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function recomputeClosedMonths(state: GroupState, fromMonth: string, providers: Providers): Promise<void> {
  for (const month of Object.keys(state.months).filter((candidate) => candidate >= fromMonth).sort()) {
    const fundMonth = state.months[month];
    if (!fundMonth) continue;
    fundMonth.openingBalance = openingBalance(state, month);
    if (fundMonth.status === "closed") {
      fundMonth.closingBalance = balance(state, `${month}-31`);
      try {
        state.driveFiles[month] = await uploadCsvWithRetry(providers, month, csvForMonth(state, month), state.driveFiles[month]);
        state.driveFailures = state.driveFailures.filter((candidate) => candidate !== month);
      } catch {
        if (!state.driveFailures.includes(month)) state.driveFailures.push(month);
      }
    }
  }
}

function previousMonth(timestamp: number): string {
  const localDate = eventDate(timestamp);
  const cursor = new Date(`${localDate.slice(0, 7)}-01T00:00:00+08:00`);
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).format(cursor);
}

async function processText(
  event: LineEvent & { source: { groupId: string; userId: string; type: "group" } },
  text: string,
  state: GroupState,
  providers: Providers,
  env: AppEnv,
): Promise<ReplyMessage | undefined> {
  if (text === "說明") return { text: HELP };
  if (text === "餘額") return balanceReply(state, event.timestamp);
  if (text === "最近紀錄" || text === "修改") {
    const entries = activeEntries(state)
      .filter((entry) => text === "最近紀錄" || entry.actorId === event.source.userId)
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, 10);
    if (entries.length === 0) return { text: "目前沒有交易紀錄。" };
    const output = entries.map((entry) => `#${entry.sequence} ${entry.date} ${money(entry.amount)} ${entry.note ?? ""} ID:${entry.id}`).join("\n");
    const bubbles = text === "修改" ? entries.map((entry) => ({
      type: "bubble",
      body: { type: "box", layout: "vertical", contents: [
        { type: "text", text: `#${entry.sequence} ${entry.date} ${money(entry.amount)}`, wrap: true },
        { type: "button", action: { type: "postback", label: "編輯", data: `action=edit&id=${entry.id}`, displayText: `編輯 ${entry.id}` } },
        { type: "button", action: { type: "postback", label: "刪除", data: `action=delete&id=${entry.id}`, displayText: `刪除 ${entry.id}` } },
        ...(entry.type === "expense" ? [{ type: "button", action: { type: "postback", label: "退款", data: `action=refund&id=${entry.id}`, displayText: `準備退款 ${entry.id}` } }] : []),
      ] },
    })) : [];
    return { text: output, ...(bubbles.length ? { flex: { type: "carousel", contents: bubbles } } : {}) };
  }
  if (text === "本月明細") {
    const month = monthOf(eventDate(event.timestamp));
    const entries = activeEntries(state).filter((entry) => monthOf(entry.date) === month);
    const total = entries.filter((entry) => entry.type === "expense").reduce((sum, entry) => sum + entry.amount, 0);
    return { text: `${month} 共 ${entries.length} 筆，本月支出 ${money(total)}\n${entries.map((entry) => `#${entry.sequence} ${entry.note ?? entry.type} ${money(entry.amount)}`).join("\n")}` };
  }
  if (["本月分析", "每月趨勢", "分類趨勢"].includes(text)) return chartReply(text, state, event.timestamp, providers);
  const retryId = text.match(/^重試 ([\w-]+)$/)?.[1];
  if (retryId) {
    const pending = state.pending.find((item) => item.id === retryId && item.kind === "retry" && item.actorId === event.source.userId && item.expiresAt >= event.timestamp);
    if (!pending) return { text: "重試已失效或不屬於你。" };
    state.pending = state.pending.filter((item) => item.id !== pending.id);
    return processText(event, pending.originalText, state, providers, env);
  }
  if (text === "重新上傳") {
    const month = [...state.driveFailures].sort().at(-1);
    if (!month) return { text: "目前沒有待重新上傳的 CSV。" };
    try {
      state.driveFiles[month] = await uploadCsvWithRetry(providers, month, csvForMonth(state, month), state.driveFiles[month]);
      state.driveFailures = state.driveFailures.filter((candidate) => candidate !== month);
      return { text: `${month} CSV 已重新上傳。` };
    } catch {
      return { text: `${month} CSV 仍無法上傳，帳務資料不受影響。` };
    }
  }
  const editId = text.match(/^編輯 ([\w-]+)$/)?.[1];
  if (editId) {
    const target = activeEntries(state).find((entry) => entry.id === editId && entry.actorId === event.source.userId);
    if (!target) return { text: "找不到你可編輯的交易。" };
    state.pending.push({ id: crypto.randomUUID(), kind: "edit", actorId: event.source.userId, groupId: event.source.groupId, expiresAt: event.timestamp + 600_000, originalText: text, targetId: target.id });
    return { text: `請在 10 分鐘內重新描述完整交易 #${target.sequence}。` };
  }
  const refundSetupId = text.match(/^退款準備 ([\w-]+)$/)?.[1];
  if (refundSetupId) {
    const target = activeEntries(state).find((entry) => entry.id === refundSetupId && entry.actorId === event.source.userId && entry.type === "expense");
    if (!target) return { text: "找不到你可退款的交易。" };
    state.pending.push({ id: crypto.randomUUID(), kind: "refund", actorId: event.source.userId, groupId: event.source.groupId, expiresAt: event.timestamp + 600_000, originalText: text, targetId: target.id });
    return { text: `請輸入「退款 ${target.id} 金額」，例如：退款 ${target.id} 300。` };
  }
  const categoryMatch = text.match(/^分類 ([\w-]+) (.+)$/);
  if (categoryMatch) {
    const selectedSmallCategory = categoryMatch[2] ?? "";
    const pending = state.pending.find((item) => item.id === categoryMatch[1] && item.actorId === event.source.userId && item.expiresAt >= event.timestamp);
    const category = Object.entries(CATEGORIES).find(([, values]) => values.includes(selectedSmallCategory as never));
    if (!pending?.transactions || !category) return { text: "分類選擇已失效或不正確。" };
    pending.transactions = pending.transactions.map((transaction) => ({ ...transaction, majorCategory: category[0], smallCategory: selectedSmallCategory }));
    return { text: `已選擇 ${category[0]}／${selectedSmallCategory}。\n確認 ${pending.id}` };
  }
  const contributionChoice = text.match(/^存入選擇 ([\w-]+) (修改原申報|額外補入)$/);
  if (contributionChoice) {
    const pending = state.pending.find((item) => item.id === contributionChoice[1] && item.kind === "contribution_choice" && item.actorId === event.source.userId && item.expiresAt >= event.timestamp);
    const proposed = pending?.transactions?.[0];
    if (!pending || !proposed) return { text: "存入選擇已失效。" };
    const month = monthState(state, monthOf(proposed.date));
    let transaction = proposed;
    if (contributionChoice[2] === "修改原申報") {
      const existingId = month.confirmations[event.source.userId]?.entryId;
      const existing = existingId ? activeEntries(state).find((entry) => entry.id === existingId) : undefined;
      if (existing) voidEntry(state, existing, { id: event.webhookEventId, timestamp: event.timestamp, originalText: pending.originalText });
    } else {
      transaction = { ...proposed, type: "topup" };
    }
    const entry = addEntry(state, transaction, { actorId: event.source.userId, originalText: pending.originalText, eventId: event.webhookEventId, now: event.timestamp });
    if (contributionChoice[2] === "修改原申報") month.confirmations[event.source.userId] = { amount: transaction.amount, entryId: entry.id };
    state.pending = state.pending.filter((item) => item.id !== pending.id);
    return receipt([transaction], state);
  }
  const confirmationId = text.match(/^確認 ([\w-]+)$/)?.[1];
  if (confirmationId) {
    const pending = state.pending.find((item) => item.id === confirmationId && item.actorId === event.source.userId && item.groupId === event.source.groupId && item.expiresAt >= event.timestamp);
    if (!pending) return { text: "確認已失效或不屬於你，未入帳。" };
    const target = pending.targetId ? activeEntries(state).find((entry) => entry.id === pending.targetId && entry.actorId === event.source.userId) : undefined;
    if (pending.targetId && !target) return { text: "原交易已不存在，未變更。" };
    if ((pending.transactions ?? []).some((transaction) => !validTransaction(transaction, eventDate(event.timestamp)))) return { text: "候選交易仍有無效欄位，未入帳。" };
    if (target && (pending.operation === "void" || pending.operation === "replace")) voidEntry(state, target, { id: event.webhookEventId, timestamp: event.timestamp, originalText: pending.originalText });
    for (const transaction of pending.transactions ?? []) addEntry(state, transaction, { actorId: event.source.userId, originalText: pending.originalText, eventId: event.webhookEventId, now: event.timestamp });
    state.pending = state.pending.filter((item) => item.id !== pending.id);
    if (pending.kind === "closed_month") await recomputeClosedMonths(state, pending.effectiveMonth ?? monthOf(pending.transactions?.[0]?.date ?? target?.date ?? eventDate(event.timestamp)), providers);
    return pending.transactions?.length ? receipt(pending.transactions, state) : { text: `已作廢交易，目前餘額：${money(balance(state))}` };
  }
  const refundMatch = text.match(/^退款 ([\w-]+) (\d+)$/);
  if (refundMatch) {
    const target = activeEntries(state).find((entry) => entry.id === refundMatch[1] && entry.actorId === event.source.userId && entry.type === "expense");
    const amount = Number(refundMatch[2]);
    if (!target || !Number.isInteger(amount) || amount <= 0) return { text: "找不到可退款的交易。" };
    const refunded = activeEntries(state).filter((entry) => entry.type === "refund" && entry.linkedTransactionId === target.id).reduce((sum, entry) => sum + entry.amount, 0);
    if (refunded + amount > target.amount) return { text: "退款累計不可超過原支出。" };
    const transaction: ParsedTransaction = {
      type: "refund", amount, date: eventDate(event.timestamp), linkedTransactionId: target.id,
      ...(target.majorCategory ? { majorCategory: target.majorCategory } : {}),
      ...(target.smallCategory ? { smallCategory: target.smallCategory } : {}),
      ...(target.note ? { note: target.note } : {}),
    };
    addEntry(state, transaction, { actorId: event.source.userId, originalText: text, eventId: event.webhookEventId, now: event.timestamp });
    return receipt([transaction], state);
  }
  const deleteId = text.match(/^刪除 ([\w-]+)$/)?.[1];
  if (deleteId) {
    const target = activeEntries(state).find((entry) => entry.id === deleteId && entry.actorId === event.source.userId);
    if (!target) return { text: "找不到你可刪除的交易。" };
    if (state.months[monthOf(target.date)]?.status === "closed") {
      const id = crypto.randomUUID();
      state.pending.push({ id, kind: "closed_month", operation: "void", actorId: event.source.userId, groupId: event.source.groupId, expiresAt: event.timestamp + 300_000, originalText: text, targetId: target.id, effectiveMonth: monthOf(target.date) });
      return { text: `這會刪除已關帳月份 ${monthOf(target.date)} 的交易並重算結轉。\n確認 ${id}` };
    }
    voidEntry(state, target, { id: event.webhookEventId, timestamp: event.timestamp, originalText: text });
    return { text: `已作廢 #${target.sequence}，目前餘額：${money(balance(state))}` };
  }
  const date = eventDate(event.timestamp);
  const usageDay = date;
  const used = state.geminiUsage[usageDay] ?? 0;
  if (used >= Number(env.GEMINI_DAILY_LIMIT)) return { text: "今日 AI 免費額度已用完；精確查詢指令仍可使用。" };
  state.geminiUsage[usageDay] = used + 1;
  let parsed;
  try {
    parsed = await providers.parse(text, { eventDate: date, categories: CATEGORIES });
  } catch {
    const id = crypto.randomUUID();
    state.pending.push({ id, kind: "retry", actorId: event.source.userId, groupId: event.source.groupId, expiresAt: event.timestamp + 600_000, originalText: text });
    return { text: `暫時無法解析，尚未入帳。\n重試 ${id}` };
  }
  if (parsed.intent === "zero_contribution") {
    const month = monthState(state, monthOf(date));
    month.confirmations[event.source.userId] = { amount: 0 };
    if ([...allowedUsers(env)].every((userId) => month.confirmations[userId])) {
      month.status = "active";
      state.thresholdBands[month.month] = balanceBand(balance(state));
    }
    return balanceReply(state, event.timestamp);
  }
  if (parsed.intent === "query") {
    if (parsed.query === "balance") return balanceReply(state, event.timestamp);
    if (parsed.query === "recent") return processText(event, "最近紀錄", state, providers, env);
    if (parsed.query === "month_detail") return processText(event, "本月明細", state, providers, env);
    return { text: "無法判斷你想查詢的內容。" };
  }
  if (parsed.intent !== "transactions" || parsed.transactions.length === 0) return { text: "無法判斷為可入帳內容，尚未入帳。" };
  const invalidBase = parsed.transactions.some((transaction) => !Number.isInteger(transaction.amount) || transaction.amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(transaction.date) || transaction.date > date);
  if (invalidBase) return { text: "交易金額或日期無效，尚未入帳。" };
  const pendingEditForCandidate = state.pending.find((item) => item.kind === "edit" && item.actorId === event.source.userId && item.expiresAt >= event.timestamp);
  if (parsed.ambiguous || parsed.transactions.some((transaction) => transaction.amount >= 10_000)) {
    const id = crypto.randomUUID();
    if (pendingEditForCandidate) state.pending = state.pending.filter((item) => item.id !== pendingEditForCandidate.id);
    state.pending.push({
      id, kind: "candidate", actorId: event.source.userId, groupId: event.source.groupId, expiresAt: event.timestamp + 600_000, originalText: text, transactions: parsed.transactions,
      ...(parsed.categoryChoices ? { choices: parsed.categoryChoices } : {}),
      ...(pendingEditForCandidate?.targetId ? { targetId: pendingEditForCandidate.targetId, operation: "replace" as const } : {}),
    });
    const choices = parsed.categoryChoices?.length ? `\n分類選擇：${parsed.categoryChoices.join("、")}` : "";
    const buttons = [
      { type: "button", action: { type: "postback", label: "確認入帳", data: `action=confirm&id=${id}`, displayText: `確認 ${id}` } },
      ...(parsed.categoryChoices ?? []).slice(0, 3).map((choice) => ({ type: "button", action: { type: "postback", label: choice, data: `action=category&id=${id}&value=${encodeURIComponent(choice)}`, displayText: `分類 ${id} ${choice}` } })),
    ];
    return { text: `此交易需要確認後才會入帳。${choices}\n確認 ${id}`, flex: { type: "bubble", body: { type: "box", layout: "vertical", contents: buttons } } };
  }
  if (parsed.transactions.some((transaction) => !validTransaction(transaction, date))) return { text: "交易欄位不完整或無效，尚未入帳。" };
  const pendingEdit = state.pending.find((item) => item.kind === "edit" && item.actorId === event.source.userId && item.expiresAt >= event.timestamp);
  if (pendingEdit?.targetId) {
    const target = activeEntries(state).find((entry) => entry.id === pendingEdit.targetId && entry.actorId === event.source.userId);
    if (!target) return { text: "原交易已不存在，未修改。" };
    if (state.months[monthOf(target.date)]?.status === "closed") {
      const id = crypto.randomUUID();
      state.pending = state.pending.filter((item) => item.id !== pendingEdit.id);
      state.pending.push({ id, kind: "closed_month", operation: "replace", actorId: event.source.userId, groupId: event.source.groupId, expiresAt: event.timestamp + 300_000, originalText: text, targetId: target.id, transactions: parsed.transactions, effectiveMonth: monthOf(target.date) });
      return { text: `這會修改已關帳月份 ${monthOf(target.date)} 並重算結轉。\n確認 ${id}` };
    }
    voidEntry(state, target, { id: event.webhookEventId, timestamp: event.timestamp, originalText: text });
    const replacements = parsed.transactions.map((transaction) => addEntry(state, transaction, { actorId: event.source.userId, originalText: text, eventId: event.webhookEventId, now: event.timestamp }));
    state.pending = state.pending.filter((item) => item.id !== pendingEdit.id);
    return receipt(replacements, state);
  }
  const closedMonth = parsed.transactions.find((transaction) => state.months[monthOf(transaction.date)]?.status === "closed");
  if (closedMonth) {
    const id = crypto.randomUUID();
    const impact = parsed.transactions.reduce((sum, transaction) => sum + signedAmount({ type: transaction.type, amount: transaction.amount }), 0);
    state.pending.push({ id, kind: "closed_month", actorId: event.source.userId, groupId: event.source.groupId, expiresAt: event.timestamp + 300_000, originalText: text, transactions: parsed.transactions });
    return { text: `這會修改已關帳月份 ${monthOf(closedMonth.date)}，目前餘額將變動 ${money(impact)}。\n確認 ${id}` };
  }
  const beforeBalance = balance(state);
  const duplicateContribution = parsed.transactions.find((transaction) => transaction.type === "contribution" && monthState(state, monthOf(transaction.date)).confirmations[event.source.userId]);
  if (duplicateContribution) {
    const id = crypto.randomUUID();
    state.pending.push({ id, kind: "contribution_choice", actorId: event.source.userId, groupId: event.source.groupId, expiresAt: event.timestamp + 600_000, originalText: text, transactions: [duplicateContribution], choices: ["修改原申報", "額外補入"] });
    const buttons = ["修改原申報", "額外補入"].map((choice) => ({ type: "button", action: { type: "postback", label: choice, data: `action=contribution&id=${id}&value=${encodeURIComponent(choice)}`, displayText: `存入選擇 ${id} ${choice}` } }));
    return { text: `本月已有存入紀錄，請選擇「修改原申報」或「額外補入」。\n確認碼 ${id}`, flex: { type: "bubble", body: { type: "box", layout: "vertical", contents: buttons } } };
  }
  for (const transaction of parsed.transactions) {
    const entry = addEntry(state, transaction, { actorId: event.source.userId, originalText: text, eventId: event.webhookEventId, now: event.timestamp });
    const month = monthState(state, monthOf(transaction.date));
    if (transaction.type === "contribution") {
      month.confirmations[event.source.userId] = { amount: transaction.amount, entryId: entry.id };
      if ([...allowedUsers(env)].every((userId) => month.confirmations[userId])) {
        month.status = "active";
        state.thresholdBands[month.month] = balanceBand(balance(state));
      }
    }
  }
  const primaryMonth = monthOf(parsed.transactions[0]?.date ?? date);
  const alert = state.months[primaryMonth]?.status === "active" ? crossingAlert(state, primaryMonth, beforeBalance, balance(state)) : undefined;
  return receipt(parsed.transactions, state, alert);
}

export function createWorker(dependencies: { store: Store; providers: Providers }): WorkerApp {
  const { store, providers } = dependencies;
  return {
    async fetch(request, env) {
      if (request.method === "GET" && new URL(request.url).pathname.startsWith("/charts/")) return providers.serveChart(request);
      if (request.method !== "POST") return new Response("Not found", { status: 404 });
      const body = await request.text();
      if (!(await validLineSignature(env.LINE_CHANNEL_SECRET, body, request.headers.get("x-line-signature")))) {
        return new Response("Invalid signature", { status: 401 });
      }
      let webhook: LineWebhook;
      try {
        webhook = JSON.parse(body) as LineWebhook;
      } catch {
        return new Response("Invalid payload", { status: 400 });
      }
      for (const event of webhook.events) {
        if (event.source?.type === "group" && event.source.groupId === env.ALLOWED_GROUP_ID && (event.type === "memberJoined" || event.type === "memberLeft")) {
          const state = await store.loadState(event.source.groupId);
          const members = event.type === "memberJoined" ? event.joined?.members : event.left?.members;
          const outsiders = (members ?? []).flatMap((member) => member.userId && !allowedUsers(env).has(member.userId) ? [member.userId] : []);
          if (event.type === "memberJoined") state.outsiderIds = [...new Set([...state.outsiderIds, ...outsiders])];
          else state.outsiderIds = state.outsiderIds.filter((userId) => !outsiders.includes(userId));
          state.suspended = state.outsiderIds.length > 0;
          await store.saveState(state);
          continue;
        }
        if (!authorized(event, env)) continue;
        const inserted = await store.beginEvent({
          id: event.webhookEventId,
          groupId: event.source.groupId,
          userId: event.source.userId,
          timestamp: event.timestamp,
          status: "received",
          raw: body,
          expiresAt: event.timestamp + 30 * 86_400_000,
        });
        if (!inserted) continue;
        try {
          if (event.type === "message" && event.message?.type === "text" && event.message.text && event.replyToken) {
            await store.withGroupLock(event.source.groupId, async () => {
              const state = await store.loadState(event.source.groupId);
              if (state.suspended) {
                await store.finishEvent(event.webhookEventId, "failed_final");
                return;
              }
              const response = await processText(event, event.message?.text ?? "", state, providers, env);
              if (response && state.pendingReceipts.length > 0) {
                response.text = `${state.pendingReceipts.map((item) => item.text).join("\n---\n")}\n---\n${response.text}`;
                state.pendingReceipts = [];
              }
              await store.saveState(state);
              if (response) {
                try {
                  await providers.reply(event.replyToken ?? "", response);
                } catch {
                  state.pendingReceipts.push(response);
                  await store.saveState(state);
                  await store.finishEvent(event.webhookEventId, "reply_pending");
                  return;
                }
              }
              await store.finishEvent(event.webhookEventId, "posted");
            });
          } else if (event.type === "postback" && event.postback?.data && event.replyToken) {
            const params = new URLSearchParams(event.postback.data);
            const action = params.get("action");
            const id = params.get("id");
            const command = action && id
              ? action === "edit" ? `編輯 ${id}`
                : action === "delete" ? `刪除 ${id}`
                  : action === "confirm" ? `確認 ${id}`
                    : action === "category" ? `分類 ${id} ${params.get("value") ?? ""}`
                      : action === "contribution" ? `存入選擇 ${id} ${params.get("value") ?? ""}`
                        : action === "refund" ? `退款準備 ${id}`
                      : ""
              : "";
            await store.withGroupLock(event.source.groupId, async () => {
              const state = await store.loadState(event.source.groupId);
              const response = await processText(event, command, state, providers, env);
              await store.saveState(state);
              if (response) await providers.reply(event.replyToken ?? "", response);
              await store.finishEvent(event.webhookEventId, "posted");
            });
          } else if (event.type === "message" && event.replyToken) {
            await providers.reply(event.replyToken, { text: "目前只支援文字記帳。" });
            await store.finishEvent(event.webhookEventId, "posted");
          } else {
            await store.finishEvent(event.webhookEventId, "failed_final");
          }
        } catch {
          await store.finishEvent(event.webhookEventId, "failed_retryable");
        }
      }
      return new Response("OK");
    },
    async scheduled(event, env) {
      await store.withGroupLock(env.ALLOWED_GROUP_ID, async () => {
      const state = await store.loadState(env.ALLOWED_GROUP_ID);
      const local = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(event.scheduledTime));
      const part = (type: Intl.DateTimeFormatPartTypes) => local.find((item) => item.type === type)?.value ?? "";
      const day = Number(part("day"));
      const hour = Number(part("hour"));
      const minute = Number(part("minute"));
      if (day === 1 && hour === 0 && minute === 10) {
        const month = previousMonth(event.scheduledTime);
        const fundMonth = monthState(state, month);
        const jobId = `close:${month}`;
        if (!state.sentJobs.includes(jobId)) {
          fundMonth.status = "closed";
          fundMonth.incomplete = ![...allowedUsers(env)].every((userId) => fundMonth.confirmations[userId]);
          fundMonth.closedAt = event.scheduledTime;
          fundMonth.closingBalance = balance(state, `${month}-31`);
          const csv = csvForMonth(state, month);
          let csvStatus = "已上傳";
          try {
            state.driveFiles[month] = await uploadCsvWithRetry(providers, month, csv, state.driveFiles[month]);
            state.driveFailures = state.driveFailures.filter((candidate) => candidate !== month);
          } catch {
            csvStatus = "失敗，可輸入「重新上傳」";
            if (!state.driveFailures.includes(month)) state.driveFailures.push(month);
          }
          state.sentJobs.push(jobId);
          if (await providers.pushAllowance() >= 2) {
            const entries = activeEntries(state).filter((entry) => monthOf(entry.date) === month);
            const contributions = entries.filter((entry) => entry.type === "contribution").reduce((sum, entry) => sum + entry.amount, 0);
            const topups = entries.filter((entry) => entry.type === "topup").reduce((sum, entry) => sum + entry.amount, 0);
            const otherIncome = entries.filter((entry) => entry.type === "income").reduce((sum, entry) => sum + entry.amount, 0);
            const refunds = entries.filter((entry) => entry.type === "refund").reduce((sum, entry) => sum + entry.amount, 0);
            const expenses = entries.filter((entry) => entry.type === "expense").reduce((sum, entry) => sum + entry.amount, 0);
            const totals = categoryTotals(state, month);
            const largestIndex = totals.reduce((best, value, index) => value > (totals[best] ?? -Infinity) ? index : best, 0);
            const largestCategory = Object.keys(CATEGORIES)[largestIndex] ?? "無";
            const missing = [...allowedUsers(env)].filter((userId) => !fundMonth.confirmations[userId]);
            await providers.push(env.ALLOWED_GROUP_ID, { text: `${month} 已結算\n共同基金存入：${money(contributions)}\n臨時補入：${money(topups)}\n其他收入：${money(otherIncome)}\n退款：${money(refunds)}\n支出：${money(expenses)}\n最大支出分類：${largestCategory}\n月底結餘：${money(fundMonth.closingBalance)}\n下月期初結轉：${money(fundMonth.closingBalance)}\nCSV：${csvStatus}${missing.length ? `\n存入未完成：${missing.join("、")}` : "\n存入狀態：已完成"}` });
          }
        }
      } else if ((day === 1 || day === 3) && hour === 9 && minute === 0) {
        const month = monthOf(eventDate(event.scheduledTime));
        const fundMonth = monthState(state, month);
        const missing = [...allowedUsers(env)].filter((userId) => !fundMonth.confirmations[userId]);
        const jobId = `reminder:${month}:${day}`;
        if (missing.length > 0 && !state.sentJobs.includes(jobId) && await providers.pushAllowance() >= 2) {
          await providers.push(env.ALLOWED_GROUP_ID, { text: `共同基金存入提醒：${missing.join("、")} 尚未確認。` });
          state.sentJobs.push(jobId);
        }
      }
      await store.cleanup(event.scheduledTime);
      await store.saveState(state);
      });
    },
  };
}
