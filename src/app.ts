import { lineSignature, validLineSignature } from "./security";
import { activeEntries, addEntry, balance, CATEGORIES, eventDate, isCalendarDate, money, monthOf, monthState, openingBalance, validTransaction } from "./domain";
import { expenseNote, normalizeTransactions, parseFundDeposit, transactionSources, unresolvedCategoryChoices } from "./transaction-parsing";
import type { AppEnv, GroupState, LineEvent, LineWebhook, ParsedTransaction, ParseResult, PendingOperation, Providers, ReplyMessage, Store, WorkerApp } from "./types";

type PreparedParse = { kind: "result" | "local"; result: ParseResult } | { kind: "failure" } | { kind: "quota" };
const DETAIL_PAGE_SIZE = 10;

const DIRECT_COMMANDS = new Set(["說明", "圖表", "明細", "系統狀態", "餘額", "最近紀錄", "修改", "本月明細", "下載 CSV", "本月分析", "每月趨勢", "分類趨勢"]);
const LOCK_FREE_COMMANDS = new Set(DIRECT_COMMANDS);

function recentMonths(current: string, count: number): string[] {
  const year = Number(current.slice(0, 4));
  const month = Number(current.slice(5, 7));
  const currentMonthIndex = year * 12 + month - 1;
  return Array.from({ length: count }, (_, index) => {
    const monthIndex = currentMonthIndex - count + index + 1;
    const targetYear = Math.floor(monthIndex / 12);
    const targetMonth = monthIndex % 12 + 1;
    return `${targetYear}-${String(targetMonth).padStart(2, "0")}`;
  });
}

function needsGemini(text: string): boolean {
  if (DIRECT_COMMANDS.has(text)) return false;
  return ![/^重試 [\w-]+$/, /^取消 [\w-]+$/, /^編輯 [\w-]+$/, /^分類 [\w-]+ .+$/, /^存入選擇 [\w-]+ (?:修改原申報|額外補入)$/, /^確認 [\w-]+$/, /^刪除 [\w-]+$/].some((pattern) => pattern.test(text));
}

async function prepareParse(text: string, state: GroupState, timestamp: number, providers: Providers, env: AppEnv): Promise<PreparedParse> {
  const date = eventDate(timestamp);
  const fundDeposit = parseFundDeposit(text, date);
  if (fundDeposit) return { kind: "local", result: fundDeposit };
  const known = parseWithKnownCategory(text, date);
  if (known) return { kind: "local", result: known };
  const learned = parseWithLearnedCategory(text, state, date);
  if (learned) return { kind: "local", result: learned };
  if ((state.geminiUsage[date] ?? 0) >= Number(env.GEMINI_DAILY_LIMIT)) return { kind: "quota" };
  try {
    return { kind: "result", result: await providers.parse(text, { eventDate: date, categories: CATEGORIES }) };
  } catch {
    return { kind: "failure" };
  }
}

function expenseWithCategory(text: string, date: string, majorCategory: string, smallCategory: string): ParseResult | undefined {
  if (/(?:存入|補入|收入|不存|退款)/.test(text)) return undefined;
  const sources = transactionSources(text, date);
  const source = sources?.length === 1 ? sources[0] : undefined;
  if (!source || !isCalendarDate(source.date) || source.date > date) return undefined;
  return { intent: "transactions", transactions: [{ type: "expense", amount: source.amount, date: source.date, majorCategory, smallCategory, note: source.description }] };
}

function parseWithKnownCategory(text: string, date: string): ParseResult | undefined {
  const sources = transactionSources(text, date);
  if (sources?.length !== 1) return undefined;
  const description = sources[0]?.description;
  const matches = Object.entries(CATEGORIES)
    .flatMap(([majorCategory, smallCategories]) => smallCategories.map((smallCategory) => ({ majorCategory, smallCategory })))
    .filter(({ smallCategory }) => description === smallCategory)
    .sort((left, right) => right.smallCategory.length - left.smallCategory.length);
  const match = matches[0];
  if (!match || matches.some((candidate) => candidate.smallCategory.length === match.smallCategory.length && candidate.smallCategory !== match.smallCategory)) return undefined;
  return expenseWithCategory(text, date, match.majorCategory, match.smallCategory);
}

function normalizedKeyword(value: string, categories: string[] = []): string {
  let normalized = value.toLowerCase();
  for (const category of categories) normalized = normalized.replaceAll(category.toLowerCase(), "");
  return normalized
    .replace(/\d+(?:瓶|包|盒|個|顆|份|組|入|件|杯|罐|袋)/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .trim();
}

function parseWithLearnedCategory(text: string, state: GroupState, date: string): ParseResult | undefined {
  if (/(?:存入|補入|收入|不存)/.test(text)) return undefined;
  const normalized = normalizedKeyword(text);
  const matches = (state.categoryRules ?? [])
    .filter((rule) => normalized.includes(rule.keyword))
    .sort((left, right) => right.keyword.length - left.keyword.length);
  const rule = matches[0];
  if (!rule || matches.some((candidate) => candidate.keyword.length === rule.keyword.length && (candidate.majorCategory !== rule.majorCategory || candidate.smallCategory !== rule.smallCategory))) return undefined;
  return expenseWithCategory(text, date, rule.majorCategory, rule.smallCategory);
}

function learnCategoryRule(state: GroupState, target: ReturnType<typeof activeEntries>[number], replacement: ParsedTransaction, timestamp: number): void {
  if (target.type !== "expense" || replacement.type !== "expense" || !replacement.majorCategory || !replacement.smallCategory) return;
  if (target.majorCategory === replacement.majorCategory && target.smallCategory === replacement.smallCategory) return;
  const source = replacement.note?.trim() || target.note?.trim();
  if (!source) return;
  const keyword = normalizedKeyword(source, [target.majorCategory ?? "", target.smallCategory ?? "", replacement.majorCategory, replacement.smallCategory]);
  if (keyword.length < 2 || keyword.length > 30) return;
  state.categoryRules ??= [];
  state.categoryRules = state.categoryRules.filter((rule) => rule.keyword !== keyword);
  state.categoryRules.push({ keyword, majorCategory: replacement.majorCategory, smallCategory: replacement.smallCategory, updatedAt: timestamp });
  state.categoryRules.sort((left, right) => right.keyword.length - left.keyword.length || right.updatedAt - left.updatedAt);
  state.categoryRules = state.categoryRules.slice(0, 100);
}

function classifyError(error: unknown): string {
  if (!(error instanceof Error)) return "internal_error";
  if (error.message === "Group is busy") return "group_lock_timeout";
  if (error.name === "AbortError" || error.name === "TimeoutError") return "external_timeout";
  if (error.message.includes("Provider request failed: 429")) return "provider_rate_limited";
  if (error.message.includes("Provider request failed:")) return "provider_error";
  return "internal_error";
}

function attachPendingReceipts(response: ReplyMessage | undefined, state: GroupState): ReplyMessage | undefined {
  state.pendingReceipts ??= [];
  if (!response || state.pendingReceipts.length === 0) return response;
  response.text = `${state.pendingReceipts.map((item) => item.text).join("\n---\n")}\n---\n${response.text}`;
  response.pendingEventIds = [...new Set(state.pendingReceipts.flatMap((item) => item.pendingEventIds ?? []))];
  state.pendingReceipts = [];
  return response;
}

function allowedUsers(env: AppEnv): Set<string> {
  return new Set(env.ALLOWED_USER_IDS.split(",").map((value) => value.trim()).filter(Boolean));
}

function memberDisplayName(state: GroupState, userId: string, env: AppEnv): string {
  const cached = state.memberNames?.[userId]?.trim();
  if (cached) return cached;
  const position = [...allowedUsers(env)].indexOf(userId);
  return position >= 0 ? `成員 ${position + 1}` : "成員";
}

function memberNameOverrides(env: AppEnv): Record<string, string> {
  if (!env.MEMBER_NAME_OVERRIDES) return {};
  try {
    const parsed = JSON.parse(env.MEMBER_NAME_OVERRIDES) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim())));
  } catch {
    return {};
  }
}

function transactionTypeLabel(type: string): string {
  const labels: Record<string, string> = { expense: "支出", contribution: "存入", topup: "補入", refund: "退款", income: "收入" };
  return labels[type] ?? type;
}

function transactionSummary(entry: ReturnType<typeof activeEntries>[number], state: GroupState): string {
  const category = entry.majorCategory ? ` ${entry.majorCategory}／${entry.smallCategory}` : "";
  const recorder = state.memberNames?.[entry.actorId] ?? "成員";
  return `#${entry.sequence} ${entry.date} ${transactionTypeLabel(entry.type)} ${money(entry.amount)}${category}${entry.note ? `｜${entry.note}` : ""}｜記錄者：${recorder}`;
}

function groupedTransactionContents(entries: ReturnType<typeof activeEntries>, state: GroupState): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];
  let currentDate = "";
  for (const entry of entries) {
    if (entry.date !== currentDate) {
      currentDate = entry.date;
      contents.push({ type: "text", text: currentDate, weight: "bold", color: "#2F6BBD", margin: "lg" });
    }
    const category = entry.majorCategory ? `${entry.majorCategory}／${entry.smallCategory}` : transactionTypeLabel(entry.type);
    const recorder = state.memberNames?.[entry.actorId] ?? "成員";
    contents.push({ type: "box", layout: "vertical", margin: "sm", contents: [
      { type: "box", layout: "horizontal", contents: [
        { type: "text", text: `#${entry.sequence} ${category}`, flex: 5, size: "sm", wrap: true },
        { type: "text", text: money(entry.amount), flex: 3, size: "sm", weight: "bold", align: "end", color: entry.type === "expense" ? "#D32F2F" : "#2E7D32" },
      ] },
      ...(entry.note ? [{ type: "text", text: entry.note, color: "#555555", size: "sm", wrap: true, margin: "xs" }] : []),
      { type: "text", text: `記錄者：${recorder}`, color: "#999999", size: "xs", margin: "xs" },
    ] });
  }
  return contents;
}

function paginationContents(view: "最近紀錄" | "本月明細" | "修改", page: number, pageCount: number): Array<Record<string, unknown>> {
  if (pageCount <= 1) return [];
  const buttons: Array<Record<string, unknown>> = [];
  if (page > 1) buttons.push({ type: "button", height: "sm", flex: 2, action: { type: "postback", label: "上一頁", data: `action=page&view=${encodeURIComponent(view)}&page=${page - 1}`, displayText: `${view} 第${page - 1}頁` } });
  buttons.push({ type: "text", text: `${page} / ${pageCount}`, flex: 1, align: "center", gravity: "center", size: "sm", color: "#777777" });
  if (page < pageCount) buttons.push({ type: "button", height: "sm", flex: 2, action: { type: "postback", label: "下一頁", data: `action=page&view=${encodeURIComponent(view)}&page=${page + 1}`, displayText: `${view} 第${page + 1}頁` } });
  return [{ type: "separator", margin: "lg" }, { type: "box", layout: "horizontal", margin: "sm", contents: buttons }];
}

function monthDetailReply(state: GroupState, timestamp: number, requestedPage = 1): ReplyMessage {
  const month = monthOf(eventDate(timestamp));
  const allEntries = activeEntries(state)
    .filter((entry) => monthOf(entry.date) === month)
    .sort((left, right) => right.date.localeCompare(left.date) || left.sequence - right.sequence);
  const pageCount = Math.max(1, Math.ceil(allEntries.length / DETAIL_PAGE_SIZE));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const entries = allEntries.slice((page - 1) * DETAIL_PAGE_SIZE, page * DETAIL_PAGE_SIZE);
  const total = allEntries.filter((entry) => entry.type === "expense").reduce((sum, entry) => sum + entry.amount, 0);
  const title = `${month} 共 ${allEntries.length} 筆`;
  const subtitle = `本月支出 ${money(total)}`;
  if (allEntries.length === 0) return { text: `${title}，${subtitle}\n目前沒有交易紀錄。` };

  const contents: Array<Record<string, unknown>> = [
    { type: "text", text: title, weight: "bold", size: "xl" },
    { type: "text", text: subtitle, color: "#777777", size: "sm", margin: "sm" },
    { type: "separator", margin: "md" },
  ];
  contents.push(...groupedTransactionContents(entries, state));
  contents.push(...paginationContents("本月明細", page, pageCount));
  return {
    text: `${title}，${subtitle}\n${entries.map((entry) => transactionSummary(entry, state)).join("\n")}`,
    flex: { type: "bubble", body: { type: "box", layout: "vertical", contents } },
  };
}

function transactionProposalSummary(transaction: ParsedTransaction): string {
  const category = transaction.majorCategory ? ` ${transaction.majorCategory}／${transaction.smallCategory ?? "分類待選"}` : "";
  return `${transaction.date} ${transactionTypeLabel(transaction.type)} ${money(transaction.amount)}${category}${transaction.note ? `｜${transaction.note}` : ""}`;
}

function transactionCopyText(entry: ReturnType<typeof activeEntries>[number]): string {
  const month = Number(entry.date.slice(5, 7));
  const day = Number(entry.date.slice(8, 10));
  const description = [...new Set([entry.smallCategory, entry.note].filter((value): value is string => Boolean(value)))].join(" ") || transactionTypeLabel(entry.type);
  return `${month}/${day} ${description} ${entry.amount}`;
}

function comparisonBox(
  label: string,
  color: string,
  transaction: ParsedTransaction,
  options: { sequence?: number; recorder?: string } = {},
): Record<string, unknown> {
  const rows = [
    ["日期", transaction.date],
    ["類型", transactionTypeLabel(transaction.type)],
    ["金額", money(transaction.amount)],
    ...(transaction.majorCategory ? [["分類", `${transaction.majorCategory}／${transaction.smallCategory ?? "分類待選"}`]] : []),
    ...(transaction.note ? [["內容", transaction.note]] : []),
    ...(options.recorder ? [["記錄者", options.recorder]] : []),
  ];
  return {
    type: "box",
    layout: "vertical",
    backgroundColor: color,
    cornerRadius: "md",
    paddingAll: "md",
    margin: "md",
    contents: [
      { type: "text", text: `${label}${options.sequence ? ` #${options.sequence}` : ""}`, weight: "bold", size: "md" },
      ...rows.map(([rowLabel, value]) => ({
        type: "box", layout: "horizontal", margin: "sm", contents: [
          { type: "text", text: rowLabel, flex: 2, size: "sm", color: "#777777" },
          { type: "text", text: value, flex: 5, size: "sm", weight: rowLabel === "金額" ? "bold" : "regular", wrap: true },
        ],
      })),
    ],
  };
}

function candidateReply(pending: PendingOperation, state: GroupState): ReplyMessage {
  const target = pending.targetId
    ? activeEntries(state).find((entry) => entry.id === pending.targetId && entry.actorId === pending.actorId)
    : undefined;
  const isEdit = pending.operation === "replace" && Boolean(target);
  const transactions = pending.transactions ?? [];
  const unresolvedIndex = transactions.findIndex((transaction) => transaction.type === "expense" && !transaction.smallCategory);
  const unresolved = unresolvedIndex >= 0 ? transactions[unresolvedIndex] : undefined;
  const unresolvedCount = transactions.filter((transaction) => transaction.type === "expense" && !transaction.smallCategory).length;
  const categoryChoices = unresolved ? (pending.choices?.length ? pending.choices : unresolvedCategoryChoices(unresolved)) : [];
  if (unresolved && categoryChoices.length) {
    const itemNumber = unresolvedIndex + 1;
    const description = unresolved.note?.trim() || transactionTypeLabel(unresolved.type);
    const resolvedCount = transactions.length - unresolvedCount;
    const choiceLabels = categoryChoices.slice(0, 3).map((choice) => {
      const category = Object.entries(CATEGORIES).find(([, values]) => values.includes(choice as never));
      return { choice, label: category ? `${category[0]}／${choice}` : choice };
    });
    const progress = unresolvedCount > 1 ? `目前先處理第 ${itemNumber} 筆，之後還有 ${unresolvedCount - 1} 筆` : `第 ${itemNumber} 筆尚未入帳`;
    const summary = resolvedCount > 0 ? `其餘 ${resolvedCount} 筆已辨識完成` : "選好分類後即可進入確認";
    return {
      text: `第 ${itemNumber} 筆需要分類：${description} ${money(unresolved.amount)}\n請選擇分類：${choiceLabels.map((item) => item.label).join("、")}\n${summary}`,
      flex: { type: "bubble", body: { type: "box", layout: "vertical", contents: [
        { type: "text", text: `有 ${unresolvedCount} 筆需要選擇分類`, weight: "bold", size: "xl", wrap: true },
        { type: "text", text: progress, color: "#D97706", size: "sm", margin: "sm", wrap: true },
        comparisonBox(`需要分類：第 ${itemNumber} 筆`, "#FFF4E5", unresolved),
        { type: "text", text: `「${description}」應歸在哪個分類？`, weight: "bold", size: "md", margin: "lg", wrap: true },
        ...choiceLabels.map(({ choice, label }, index) => ({
          type: "button",
          style: index === 0 ? "primary" : "secondary",
          ...(index === 0 ? { color: "#2E7D32" } : {}),
          margin: index === 0 ? "md" : "sm",
          action: { type: "postback", label, data: `action=category&id=${pending.id}&value=${encodeURIComponent(choice)}`, displayText: `第 ${itemNumber} 筆選擇分類：${label}` },
        })),
        { type: "text", text: `✓ ${summary}`, color: "#2E7D32", size: "sm", margin: "lg", wrap: true },
        { type: "button", style: "secondary", margin: "md", action: { type: "postback", label: isEdit ? "取消修改" : "取消整批", data: `action=cancel&id=${pending.id}`, displayText: isEdit && target ? `取消修改 #${target.sequence}` : "取消整批入帳" } },
      ] } },
    };
  }
  const preview = isEdit && target
    ? `修改前：${transactionSummary(target, state)}\n修改後：${transactions.map(transactionProposalSummary).join("\n")}`
    : `待入帳：${transactions.map(transactionProposalSummary).join("\n")}`;
  const closedMonthWarning = pending.kind === "closed_month" ? "\n已關帳月份，確認後將重算結轉。" : "";
  const choices = pending.choices?.length ? `\n分類選擇：${pending.choices.join("、")}` : "";
  const buttons = [
    ...(pending.choices ?? []).slice(0, 3).map((choice) => ({
      type: "button",
      action: { type: "postback", label: choice, data: `action=category&id=${pending.id}&value=${encodeURIComponent(choice)}`, displayText: `選擇分類：${choice}` },
    })),
    { type: "button", style: "primary", color: "#2E7D32", margin: "lg", action: { type: "postback", label: isEdit ? "確認修改" : "確認入帳", data: `action=confirm&id=${pending.id}`, displayText: isEdit && target ? `確認修改 #${target.sequence}` : "確認入帳" } },
    { type: "button", style: "secondary", margin: "sm", action: { type: "postback", label: isEdit ? "取消修改" : "取消入帳", data: `action=cancel&id=${pending.id}`, displayText: isEdit && target ? `取消修改 #${target.sequence}` : "取消入帳" } },
  ];
  const contents = isEdit && target
    ? [
      { type: "text", text: "確認交易修改", weight: "bold", size: "xl" },
      { type: "text", text: pending.kind === "closed_month" ? "已關帳月份，確認後將重算結轉" : "請確認修改前後內容", color: pending.kind === "closed_month" ? "#D32F2F" : "#777777", size: "sm", margin: "sm", wrap: true },
      comparisonBox("修改前", "#F2F3F5", target, { sequence: target.sequence, recorder: state.memberNames?.[target.actorId] ?? "成員" }),
      { type: "text", text: "↓", align: "center", color: "#2E7D32", weight: "bold", size: "xl", margin: "sm" },
      ...transactions.map((transaction) => comparisonBox("修改後", "#EAF5EC", transaction)),
      ...buttons,
    ]
    : [
      { type: "text", text: "確認交易內容", weight: "bold", size: "xl" },
      ...(pending.kind === "closed_month"
        ? [{ type: "text", text: "已關帳月份，確認後將重算結轉", color: "#D32F2F", weight: "bold", size: "sm", margin: "sm", wrap: true }]
        : transactions.some((transaction) => transaction.amount >= 10_000)
        ? [{ type: "text", text: "高額交易，請再次確認", color: "#D32F2F", weight: "bold", size: "sm", margin: "sm" }]
        : [{ type: "text", text: "請確認後再入帳", color: "#777777", size: "sm", margin: "sm" }]),
      ...transactions.map((transaction, index) => comparisonBox(transactions.length > 1 ? `待入帳 ${index + 1}` : "待入帳", "#F7F8FA", transaction)),
      ...buttons,
    ];
  return {
    text: `${preview}${closedMonthWarning}${choices}`,
    flex: {
      type: "bubble",
      body: { type: "box", layout: "vertical", contents },
    },
  };
}

function retryReply(id: string): ReplyMessage {
  return {
    text: "暫時無法解析，尚未入帳。請點選「重新嘗試」，或重新輸入。",
    flex: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "暫時無法解析，尚未入帳。", wrap: true },
          { type: "button", style: "primary", color: "#2E7D32", margin: "md", action: { type: "postback", label: "重新嘗試", data: `action=retry&id=${id}`, displayText: "重新嘗試" } },
        ],
      },
    },
  };
}

function closedMonthDeletionReply(pending: PendingOperation, target: ReturnType<typeof activeEntries>[number], state: GroupState): ReplyMessage {
  const preview = `將刪除：${transactionSummary(target, state)}\n已關帳月份 ${monthOf(target.date)}，確認後將重算結轉。`;
  return {
    text: preview,
    flex: { type: "bubble", body: { type: "box", layout: "vertical", contents: [
      { type: "text", text: "確認刪除交易", weight: "bold", size: "xl" },
      { type: "text", text: `已關帳月份 ${monthOf(target.date)}，確認後將重算結轉`, color: "#D32F2F", weight: "bold", size: "sm", margin: "sm", wrap: true },
      comparisonBox("將刪除", "#FDECEC", target, { sequence: target.sequence, recorder: state.memberNames?.[target.actorId] ?? "成員" }),
      { type: "button", style: "primary", color: "#D32F2F", margin: "lg", action: { type: "postback", label: "確認刪除", data: `action=confirm&id=${pending.id}`, displayText: `確認刪除 #${target.sequence}` } },
      { type: "button", style: "secondary", margin: "sm", action: { type: "postback", label: "取消刪除", data: `action=cancel&id=${pending.id}`, displayText: `取消刪除 #${target.sequence}` } },
    ] } },
  };
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

async function cacheMemberNames(state: GroupState, groupId: string, env: AppEnv, providers: Providers): Promise<void> {
  state.memberNames ??= {};
  const overrides = memberNameOverrides(env);
  for (const userId of allowedUsers(env)) if (overrides[userId]) state.memberNames[userId] = overrides[userId];
  await Promise.all([...allowedUsers(env)].map(async (userId) => {
    if (overrides[userId]) return;
    if (state.memberNames[userId]) return;
    try {
      const displayName = await providers.memberName(groupId, userId);
      if (displayName) state.memberNames[userId] = displayName;
    } catch {
      // Profile lookup must never prevent accounting; a later event will retry.
    }
  }));
}

function receipt(transactions: ParsedTransaction[], state: GroupState, alert?: string): ReplyMessage {
  const lines = transactions.map((transaction) => {
    const category = transaction.majorCategory ? ` ${transaction.majorCategory}／${transaction.smallCategory}` : "";
    return `${transaction.date} ${transactionTypeLabel(transaction.type)} ${money(transaction.amount)}${category}${transaction.note ? `｜${transaction.note}` : ""}`;
  });
  const currentMonth = monthState(state, monthOf(transactions[0]?.date ?? eventDate(Date.now())));
  const label = currentMonth.status === "active" ? "餘額" : "餘額（本月存入未完成）";
  const expenseTotal = transactions.length > 1 && transactions.every((transaction) => transaction.type === "expense")
    ? `本次支出總額：${money(transactions.reduce((total, transaction) => total + transaction.amount, 0))}`
    : undefined;
  const text = `${lines.join("\n")}${expenseTotal ? `\n${expenseTotal}` : ""}\n${label}：${money(balance(state))}${alert ? `\n${alert}` : ""}`;
  const contents: Array<Record<string, unknown>> = lines.map((line) => ({ type: "text", text: line, wrap: true, size: "sm" }));
  if (expenseTotal) contents.push({ type: "text", text: expenseTotal, wrap: true, weight: "bold", margin: "md" });
  contents.push(
    { type: "separator", margin: "md" },
    { type: "text", text: `${label}：${money(balance(state))}`, wrap: true, weight: "bold", margin: "md" },
  );
  if (alert) contents.push({ type: "text", text: alert, wrap: true, color: "#D32F2F", margin: "sm" });
  return {
    text,
    flex: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents,
      },
    },
  };
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

function balanceReply(state: GroupState, timestamp: number, env: AppEnv): ReplyMessage {
  const currentMonth = monthOf(eventDate(timestamp));
  const month = monthState(state, currentMonth);
  const label = month.status === "active" ? "餘額" : "餘額（本月存入未完成）";
  const priorMonthLabel = `${Number(previousMonth(timestamp).slice(5, 7))}月餘額`;
  const contributionLabel = `${Number(currentMonth.slice(5, 7))}月存入`;
  const users = [...allowedUsers(env)];
  const status = (userId: string | undefined): string => userId && month.confirmations[userId] ? money(month.confirmations[userId].amount) : "未確認";
  const memberStatuses = users.map((userId) => ({ name: memberDisplayName(state, userId, env), value: status(userId) }));
  const statuses = memberStatuses.map((member) => `${member.name}：${member.value}`).join("、");
  const currentBalance = money(balance(state));
  const priorBalance = money(month.openingBalance);
  return {
    text: `${label}：${currentBalance}\n${priorMonthLabel}：${priorBalance}\n${contributionLabel}：${statuses}`,
    flex: {
      type: "bubble",
      body: { type: "box", layout: "vertical", contents: [
        { type: "text", text: label, color: "#777777", size: "sm" },
        { type: "text", text: currentBalance, weight: "bold", size: "xxl", margin: "sm" },
        { type: "separator", margin: "md" },
        { type: "text", text: priorMonthLabel, weight: "bold", margin: "md" },
        { type: "text", text: priorBalance, wrap: true, size: "sm", margin: "sm" },
        { type: "text", text: contributionLabel, weight: "bold", margin: "md" },
        ...memberStatuses.map((member) => ({ type: "text", text: `${member.name}：${member.value}`, wrap: true, size: "sm", margin: "sm" })),
      ] },
    },
  };
}

function recentRecordsReply(allEntries: ReturnType<typeof activeEntries>, state: GroupState, requestedPage = 1): ReplyMessage {
  const sorted = [...allEntries].sort((left, right) => right.date.localeCompare(left.date) || right.sequence - left.sequence);
  const pageCount = Math.max(1, Math.ceil(sorted.length / DETAIL_PAGE_SIZE));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const entries = sorted.slice((page - 1) * DETAIL_PAGE_SIZE, page * DETAIL_PAGE_SIZE);
  const output = entries.map((entry) => transactionSummary(entry, state)).join("\n");
  const contents: Array<Record<string, unknown>> = [
    { type: "text", text: "最近紀錄", weight: "bold", size: "xl" },
    { type: "text", text: `共 ${sorted.length} 筆交易`, color: "#777777", size: "sm", margin: "sm" },
    { type: "separator", margin: "md" },
  ];
  contents.push(...groupedTransactionContents(entries, state));
  contents.push(...paginationContents("最近紀錄", page, pageCount));
  return { text: output, flex: { type: "bubble", body: { type: "box", layout: "vertical", contents } } };
}

function transactionManagementReply(allEntries: ReturnType<typeof activeEntries>, state: GroupState, requestedPage = 1): ReplyMessage {
  const pageCount = Math.max(1, Math.ceil(allEntries.length / DETAIL_PAGE_SIZE));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const entries = allEntries.slice((page - 1) * DETAIL_PAGE_SIZE, page * DETAIL_PAGE_SIZE);
  const output = entries.map((entry) => transactionSummary(entry, state)).join("\n");
  const contents: Array<Record<string, unknown>> = [
    { type: "text", text: "修改交易", weight: "bold", size: "xl" },
    { type: "text", text: `共 ${allEntries.length} 筆由你記錄的交易`, color: "#777777", size: "sm", margin: "sm" },
    { type: "separator", margin: "md" },
  ];
  for (const entry of entries) {
    const category = entry.majorCategory ? `${entry.majorCategory}／${entry.smallCategory}` : transactionTypeLabel(entry.type);
    contents.push({ type: "box", layout: "vertical", margin: "md", backgroundColor: "#F7F8FA", cornerRadius: "md", paddingAll: "md", contents: [
      { type: "text", text: `#${entry.sequence}　${entry.date}`, color: "#777777", size: "xs" },
      { type: "box", layout: "horizontal", contents: [
        { type: "text", text: `${transactionTypeLabel(entry.type)}｜${category}`, flex: 5, weight: "bold", size: "sm", margin: "sm", wrap: true },
        { type: "text", text: money(entry.amount), flex: 3, weight: "bold", size: "md", align: "end", margin: "sm", color: entry.type === "expense" ? "#D32F2F" : "#2E7D32" },
      ] },
      ...(entry.note ? [{ type: "text", text: entry.note, wrap: true, color: "#555555", size: "sm", margin: "xs" }] : []),
      { type: "separator", margin: "sm" },
      { type: "box", layout: "horizontal", margin: "sm", contents: [
        { type: "button", height: "sm", flex: 1, style: "link", color: "#2F6BBD", action: { type: "postback", label: "編輯", data: `action=edit&id=${entry.id}`, displayText: `編輯 #${entry.sequence}` } },
        { type: "button", height: "sm", flex: 1, style: "link", color: "#2F6BBD", action: { type: "clipboard", label: "複製", clipboardText: transactionCopyText(entry) } },
        { type: "button", height: "sm", flex: 1, style: "link", color: "#D32F2F", action: { type: "postback", label: "刪除", data: `action=delete&id=${entry.id}`, displayText: `刪除 #${entry.sequence}` } },
      ] },
    ] });
  }
  contents.push(...paginationContents("修改", page, pageCount));
  return { text: output, flex: { type: "bubble", body: { type: "box", layout: "vertical", contents } } };
}

function monthCloseReply(args: {
  month: string;
  contributions: number;
  topups: number;
  otherIncome: number;
  expenses: number;
  largestCategory: string;
  closingBalance: number;
  missingNames: string[];
}): ReplyMessage {
  const rows = [
    ["共同基金存入", money(args.contributions)],
    ["臨時補入", money(args.topups)],
    ["其他收入", money(args.otherIncome)],
    ["支出", money(args.expenses)],
    ["最大支出分類", args.largestCategory],
    ["月底結餘", money(args.closingBalance)],
    ["下月期初結轉", money(args.closingBalance)],
  ];
  const contributionStatus = args.missingNames.length ? `存入未完成：${args.missingNames.join("、")}` : "存入狀態：已完成";
  const text = [`${args.month} 已結算`, ...rows.map(([label, value]) => `${label}：${value}`), "CSV：可從「明細」下載", contributionStatus].join("\n");
  const contents: Array<Record<string, unknown>> = [
    { type: "text", text: `${args.month} 月底關帳`, weight: "bold", size: "xl" },
    { type: "text", text: contributionStatus, color: args.missingNames.length ? "#D32F2F" : "#2E7D32", size: "sm", margin: "sm" },
    { type: "separator", margin: "md" },
  ];
  for (const [label, value] of rows) {
    contents.push({ type: "box", layout: "horizontal", margin: "md", contents: [
      { type: "text", text: label, flex: 3, size: "sm", color: "#777777" },
      { type: "text", text: value, flex: 2, size: "sm", weight: "bold", align: "end", wrap: true },
    ] });
  }
  contents.push({ type: "text", text: "CSV 可從「明細」下載", color: "#777777", size: "xs", margin: "lg" });
  return { text, flex: { type: "bubble", body: { type: "box", layout: "vertical", contents } } };
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

function categoryRankingReply(title: string, subtitle: string | undefined, labels: string[], values: number[], insights: string[] = []): ReplyMessage {
  const total = values.reduce((sum, value) => sum + value, 0);
  const rows = labels
    .map((label, index) => ({ label, value: values[index] ?? 0 }))
    .filter((row) => row.value > 0)
    .sort((left, right) => right.value - left.value);
  if (rows.length === 0) return { text: `${title}\n本月尚無支出資料。` };
  const lines = rows.map((row) => `${row.label}：${money(row.value)}（${Math.round(row.value / total * 100)}%）`);
  const contents: Array<Record<string, unknown>> = [
    { type: "text", text: title, weight: "bold", size: "lg" },
    ...(subtitle ? [{ type: "text", text: subtitle, wrap: true, size: "sm", color: "#777777", margin: "sm" }] : []),
    { type: "separator", margin: "md" },
  ];
  for (const row of rows) {
    contents.push({
      type: "box", layout: "horizontal", margin: "md", contents: [
        { type: "text", text: row.label, flex: 2, size: "md" },
        { type: "text", text: money(row.value), flex: 3, size: "md", weight: "bold", align: "end" },
        { type: "text", text: `${Math.round(row.value / total * 100)}%`, flex: 1, size: "sm", color: "#777777", align: "end" },
      ],
    });
  }
  contents.push({ type: "separator", margin: "md" }, { type: "text", text: `合計：${money(total)}`, weight: "bold", margin: "md" });
  if (insights.length) {
    contents.push(
      { type: "separator", margin: "lg" },
      { type: "text", text: "智慧洞察", weight: "bold", color: "#2F6BBD", margin: "md" },
      ...insights.map((insight) => ({ type: "text", text: `• ${insight}`, wrap: true, size: "sm", margin: "sm" })),
    );
  }
  return { text: [title, ...(subtitle ? [subtitle] : []), ...lines, `合計：${money(total)}`, ...(insights.length ? ["智慧洞察", ...insights.map((insight) => `• ${insight}`)] : [])].join("\n"), flex: { type: "bubble", body: { type: "box", layout: "vertical", contents } } };
}

function expenseTotal(state: GroupState, month: string): number {
  return activeEntries(state).filter((entry) => monthOf(entry.date) === month && entry.type === "expense").reduce((sum, entry) => sum + entry.amount, 0);
}

interface LocalInsightFacts {
  currentExpenses: number;
  previousExpenses: number;
  largestCategory: string;
  largestCategoryAmount: number;
  projectedExpenses: number;
  currentBalance: number;
  projectedBalance: number;
}

function insightFacts(state: GroupState, timestamp: number, labels: string[], values: number[]): LocalInsightFacts {
  const date = eventDate(timestamp);
  const month = monthOf(date);
  const [year, monthNumber] = month.split("-").map(Number);
  const throughDay = Number(date.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(year ?? 0, monthNumber ?? 1, 0)).getUTCDate();
  const currentExpenses = values.reduce((sum, value) => sum + value, 0);
  const previousExpenses = expenseTotal(state, previousMonth(timestamp));
  const largestIndex = values.reduce((best, value, index) => value > (values[best] ?? -1) ? index : best, 0);
  const projectedExpenses = throughDay > 0 ? Math.round(currentExpenses / throughDay * daysInMonth) : currentExpenses;
  const currentBalance = balance(state);
  return {
    currentExpenses,
    previousExpenses,
    largestCategory: labels[largestIndex] ?? "無",
    largestCategoryAmount: values[largestIndex] ?? 0,
    projectedExpenses,
    currentBalance,
    projectedBalance: currentBalance - Math.max(0, projectedExpenses - currentExpenses),
  };
}

function localInsights(facts: LocalInsightFacts): string[] {
  const comparison = facts.previousExpenses > 0
    ? `本月支出較上月${facts.currentExpenses >= facts.previousExpenses ? "增加" : "減少"} ${money(Math.abs(facts.currentExpenses - facts.previousExpenses))}。`
    : "上月資料不足，暫不比較月增減。";
  return [
    comparison,
    `最大支出分類為${facts.largestCategory}，共 ${money(facts.largestCategoryAmount)}。`,
    `依目前速度，月底預估支出 ${money(facts.projectedExpenses)}、餘額 ${money(facts.projectedBalance)}。`,
  ];
}

async function chartReply(command: string, state: GroupState, timestamp: number, providers: Providers): Promise<ReplyMessage> {
  const current = monthOf(eventDate(timestamp));
  if (command === "本月分析") {
    const labels = Object.keys(CATEGORIES);
    const values = categoryTotals(state, current);
    const facts = insightFacts(state, timestamp, labels, values);
    return categoryRankingReply("本月分類排行", undefined, labels, values, localInsights(facts));
  }
  const months = recentMonths(current, 6);
  if (command === "每月趨勢") {
    const contributions = months.map((month) => activeEntries(state).filter((entry) => monthOf(entry.date) === month && ["contribution", "topup", "income"].includes(entry.type)).reduce((sum, entry) => sum + entry.amount, 0));
    const expenses = months.map((month) => categoryTotals(state, month).reduce((sum, value) => sum + value, 0));
    const closings = months.map((month) => state.months[month]?.closingBalance ?? balance(state, `${month}-31`));
    const activeIndexes = months.flatMap((_, index) => contributions[index] || expenses[index] ? [index] : []);
    if (activeIndexes.length < 2) {
      const index = activeIndexes[0];
      const detail = index === undefined ? "目前尚無月份資料。" : `${months[index]}：存入 ${money(contributions[index] ?? 0)}、支出 ${money(expenses[index] ?? 0)}、餘額 ${money(closings[index] ?? 0)}`;
      return { text: `每月趨勢\n${detail}\n累積至少 2 個月後顯示趨勢圖。` };
    }
    const activeMonths = activeIndexes.map((index) => months[index] ?? "");
    const activeContributions = activeIndexes.map((index) => contributions[index] ?? 0);
    const activeExpenses = activeIndexes.map((index) => expenses[index] ?? 0);
    const activeClosings = activeIndexes.map((index) => closings[index] ?? 0);
    const summary = [`最近 ${activeMonths.length} 個有效月份支出 ${money(activeExpenses.reduce((sum, value) => sum + value, 0))}`];
    try {
      const url = await providers.chart("monthly-trend", { labels: activeMonths, datasets: [{ label: "存入", values: activeContributions }, { label: "支出", values: activeExpenses }, { label: "月底結餘", values: activeClosings }], summary });
      return { text: summary.join("\n"), flex: chartFlex(url, summary) };
    } catch {
      return { text: `${summary.join("\n")}\n圖表暫時無法產生。` };
    }
  }
  const categoryValues = months.map((month) => categoryTotals(state, month));
  const activeIndexes = months.flatMap((_, index) => categoryValues[index]?.some((value) => value > 0) ? [index] : []);
  if (activeIndexes.length < 2) {
    return categoryRankingReply("分類趨勢", "目前只有 1 個有效月份；累積至少 2 個月後顯示趨勢圖。", Object.keys(CATEGORIES), categoryValues[activeIndexes[0] ?? months.length - 1] ?? []);
  }
  const activeMonths = activeIndexes.map((index) => months[index] ?? "");
  const datasets = Object.keys(CATEGORIES)
    .map((category, categoryIndex) => ({ label: category, values: activeIndexes.map((monthIndex) => categoryValues[monthIndex]?.[categoryIndex] ?? 0) }))
    .filter((dataset) => dataset.values.some((value) => value > 0));
  const summary = [`最近 ${activeMonths.length} 個有效月份分類趨勢`];
  try {
    const url = await providers.chart("category-trend", { labels: activeMonths, datasets, summary });
    return { text: summary.join("\n"), flex: chartFlex(url, summary) };
  } catch {
    return { text: `${summary.join("\n")}\n圖表暫時無法產生。` };
  }
}

function chartFlex(url: string, summary: string[]): Record<string, unknown> {
  return {
    type: "bubble",
    hero: { type: "image", url, size: "full", aspectRatio: "4:5", aspectMode: "fit" },
    body: { type: "box", layout: "vertical", contents: summary.map((text) => ({ type: "text", text, wrap: true, size: "sm" })) },
  };
}

function chartMenuReply(): ReplyMessage {
  const commands = ["本月分析", "每月趨勢", "分類趨勢"];
  return {
    text: "請選擇圖表功能：本月分析、每月趨勢、分類趨勢。",
    flex: {
      type: "bubble",
      body: {
        type: "box", layout: "vertical", contents: [
          { type: "text", text: "圖表", weight: "bold", size: "xl" },
          { type: "text", text: "請選擇要查看的分析", color: "#777777", size: "sm", margin: "sm" },
          { type: "separator", margin: "md" },
          ...commands.map((command) => ({ type: "button", margin: "sm", action: { type: "postback", label: command, data: `action=chart&value=${encodeURIComponent(command)}`, displayText: command } })),
        ],
      },
    },
  };
}

function detailMenuReply(): ReplyMessage {
  const commands = [
    { label: "最近紀錄", command: "最近紀錄" },
    { label: "本月明細", command: "本月明細" },
    { label: "下載 CSV", command: "下載 CSV" },
    { label: "修改交易", command: "修改" },
  ];
  return {
    text: "請選擇明細功能：最近紀錄、本月明細、修改交易。",
    flex: {
      type: "bubble",
      body: {
        type: "box", layout: "vertical", contents: [
          { type: "text", text: "明細", weight: "bold", size: "xl" },
          { type: "text", text: "請選擇要查看或管理的內容", color: "#777777", size: "sm", margin: "sm" },
          { type: "separator", margin: "md" },
          ...commands.map(({ label, command }) => ({ type: "button", margin: "sm", action: { type: "postback", label, data: `action=detail&value=${encodeURIComponent(command)}`, displayText: label } })),
        ],
      },
    },
  };
}

function mainMenuReply(): ReplyMessage {
  const commands = ["餘額", "明細", "圖表", "系統狀態"];
  return {
    text: "請選擇功能：餘額、明細、圖表、系統狀態。",
    flex: {
      type: "bubble",
      body: {
        type: "box", layout: "vertical", contents: [
          { type: "text", text: "共同基金", weight: "bold", size: "xl" },
          { type: "text", text: "請選擇要使用的功能", color: "#777777", size: "sm", margin: "sm" },
          { type: "separator", margin: "md" },
          ...commands.map((command) => ({ type: "button", margin: "sm", action: { type: "postback", label: command, data: `action=menu&value=${encodeURIComponent(command)}`, displayText: command } })),
        ],
      },
    },
  };
}

const ERROR_LABELS: Record<string, string> = {
  line_reply_failed: "LINE 回覆失敗",
  group_lock_timeout: "處理佇列逾時",
  external_timeout: "外部服務逾時",
  provider_rate_limited: "外部服務額度限制",
  provider_error: "外部服務失敗",
  internal_error: "系統處理失敗",
};

async function systemStatusReply(state: GroupState, timestamp: number, providers: Providers, env: AppEnv, store: Store): Promise<ReplyMessage> {
  const geminiLimit = Number(env.GEMINI_DAILY_LIMIT);
  const geminiUsed = state.geminiUsage[eventDate(timestamp)] ?? 0;
  let lineStatus = "LINE Push 本月：暫時無法取得。";
  try {
    const lineLimit = Number(env.LINE_PUSH_MONTHLY_LIMIT);
    const lineRemaining = await providers.pushAllowance();
    lineStatus = `LINE Push 本月：已用 ${Math.max(0, lineLimit - lineRemaining)}、剩餘 ${lineRemaining} / ${lineLimit} 則`;
  } catch {
    // Gemini usage remains available when LINE quota lookup fails.
  }
  const geminiStatus = `Gemini 今日：${geminiUsed} / ${geminiLimit} 次`;
  const learningStatus = `分類學習規則：${state.categoryRules?.length ?? 0} 筆`;
  let healthStatus = "最近 24 小時：暫時無法取得。";
  try {
    const errors = await store.errorSummary(state.groupId, timestamp - 24 * 60 * 60 * 1000);
    healthStatus = errors.total === 0
      ? "最近 24 小時：運作正常"
      : `最近 24 小時：${errors.total} 筆異常（${Object.entries(errors.byCode).map(([code, count]) => `${ERROR_LABELS[code] ?? "其他錯誤"} ${count}`).join("、")}）`;
  } catch {
    // Provider quota status remains available when D1 health lookup fails.
  }
  return {
    text: `${geminiStatus}\n${lineStatus}\n${learningStatus}\n${healthStatus}`,
    flex: {
      type: "bubble",
      body: { type: "box", layout: "vertical", contents: [
        { type: "text", text: "系統狀態", weight: "bold", size: "xl" },
        { type: "separator", margin: "md" },
        { type: "text", text: geminiStatus, wrap: true, margin: "md" },
        { type: "text", text: lineStatus, wrap: true, margin: "md" },
        { type: "text", text: learningStatus, wrap: true, margin: "md" },
        { type: "text", text: healthStatus, wrap: true, margin: "md" },
      ] },
    },
  };
}

function csvForMonth(state: GroupState, month: string): string {
  const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const header = ["日期", "類型", "金額", "大分類", "小分類", "備註", "建立者名稱", "輸入原文", "建立時間", "狀態", "關聯交易"];
  const rows = state.ledger.filter((entry) => monthOf(entry.date) === month).map((entry) => [entry.date, entry.type, entry.amount, entry.majorCategory, entry.smallCategory, entry.note, state.memberNames?.[entry.actorId] ?? "成員", entry.originalText, new Date(entry.createdAt).toISOString(), entry.status, entry.linkedTransactionId ?? entry.revisionOf]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(quote).join(",")).join("\r\n")}`;
}

async function csvDownloadReply(state: GroupState, timestamp: number, store: Store, env: AppEnv): Promise<ReplyMessage> {
  if (!env.PUBLIC_BASE_URL || !env.CHART_SIGNING_SECRET) return { text: "CSV 下載尚未完成系統設定。" };
  const month = monthOf(eventDate(timestamp));
  const token = crypto.randomUUID();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const filename = `共同基金_${month}.csv`;
  await store.saveCsvExport(token, csvForMonth(state, month), filename, expiresAt);
  const signature = await lineSignature(env.CHART_SIGNING_SECRET, `csv.${token}.${expiresAt}`);
  const url = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/exports/${encodeURIComponent(token)}?expires=${expiresAt}&signature=${encodeURIComponent(signature)}`;
  return {
    text: `${month} CSV 已產生，下載連結 10 分鐘內有效。\n${url}`,
    flex: { type: "bubble", body: { type: "box", layout: "vertical", contents: [
      { type: "text", text: `${month} 帳本 CSV`, weight: "bold", size: "xl" },
      { type: "text", text: "下載連結 10 分鐘內有效", color: "#777777", size: "sm", margin: "sm" },
      { type: "button", margin: "md", action: { type: "uri", label: "下載 CSV", uri: url } },
    ] } },
  };
}

async function serveCsvExport(request: Request, store: Store, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const token = url.pathname.split("/").at(-1) ?? "";
  const expiresAt = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature") ?? "";
  if (!env.CHART_SIGNING_SECRET || !token || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return new Response("Not found", { status: 404 });
  const expected = await lineSignature(env.CHART_SIGNING_SECRET, `csv.${token}.${expiresAt}`);
  if (expected !== signature) return new Response("Not found", { status: 404 });
  const item = await store.loadCsvExport(token);
  if (!item || item.expiresAt !== expiresAt || item.expiresAt < Date.now()) return new Response("Not found", { status: 404 });
  return new Response(item.csv, { headers: {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(item.filename)}`,
    "cache-control": "private, no-store",
  } });
}

async function recomputeClosedMonths(state: GroupState, fromMonth: string): Promise<void> {
  for (const month of Object.keys(state.months).filter((candidate) => candidate >= fromMonth).sort()) {
    const fundMonth = state.months[month];
    if (!fundMonth) continue;
    fundMonth.openingBalance = openingBalance(state, month);
    if (fundMonth.status === "closed") {
      fundMonth.closingBalance = balance(state, `${month}-31`);
    }
  }
}

function earliestClosedMonth(state: GroupState, transactions: ParsedTransaction[], target?: { date: string }): string | undefined {
  return [...transactions.map((transaction) => monthOf(transaction.date)), ...(target ? [monthOf(target.date)] : [])]
    .filter((month) => state.months[month]?.status === "closed")
    .sort()[0];
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
  store: Store,
  preparedParse?: PreparedParse,
): Promise<ReplyMessage | undefined> {
  const existingTransactions = activeEntries(state).filter((entry) => entry.eventId === event.webhookEventId);
  if (existingTransactions.length > 0) return receipt(existingTransactions, state);
  const pageMatch = text.match(/^(最近紀錄|本月明細|修改) 第(\d+)頁$/);
  const view = pageMatch?.[1] ?? text;
  const requestedPage = Number(pageMatch?.[2] ?? 1);
  if (text === "說明") return mainMenuReply();
  if (text === "圖表") return chartMenuReply();
  if (text === "明細") return detailMenuReply();
  if (text === "系統狀態") return systemStatusReply(state, event.timestamp, providers, env, store);
  if (text === "餘額") return balanceReply(state, event.timestamp, env);
  if (view === "最近紀錄" || view === "修改") {
    const entries = activeEntries(state)
      .filter((entry) => view === "最近紀錄" || entry.actorId === event.source.userId)
      .sort((left, right) => right.sequence - left.sequence);
    if (entries.length === 0) return { text: "目前沒有交易紀錄。" };
    if (view === "最近紀錄") return recentRecordsReply(entries, state, requestedPage);
    return transactionManagementReply(entries, state, requestedPage);
  }
  if (view === "本月明細") {
    return monthDetailReply(state, event.timestamp, requestedPage);
  }
  if (text === "下載 CSV") return csvDownloadReply(state, event.timestamp, store, env);
  if (["本月分析", "每月趨勢", "分類趨勢"].includes(text)) return chartReply(text, state, event.timestamp, providers);
  const retryId = text.match(/^重試 ([\w-]+)$/)?.[1];
  if (retryId) {
    const pending = state.pending.find((item) => item.id === retryId && item.kind === "retry" && item.actorId === event.source.userId && item.expiresAt >= event.timestamp);
    if (!pending) return { text: "重試已失效或不屬於你。" };
    state.pending = state.pending.filter((item) => item.id !== pending.id);
    return processText(event, pending.originalText, state, providers, env, store);
  }
  const cancelId = text.match(/^取消 ([\w-]+)$/)?.[1];
  if (cancelId) {
    const pending = state.pending.find((item) => item.id === cancelId && item.actorId === event.source.userId && item.groupId === event.source.groupId && item.expiresAt >= event.timestamp);
    if (!pending) return { text: "取消已失效或不屬於你。" };
    state.pending = state.pending.filter((item) => item.id !== pending.id);
    return { text: pending.operation === "replace" ? "已取消修改，原交易保持不變。" : "已取消入帳。" };
  }
  const editId = text.match(/^編輯 ([\w-]+)$/)?.[1];
  if (editId) {
    const target = activeEntries(state).find((entry) => entry.id === editId && entry.actorId === event.source.userId);
    if (!target) return { text: "找不到你可編輯的交易。" };
    state.pending.push({ id: crypto.randomUUID(), kind: "edit", actorId: event.source.userId, groupId: event.source.groupId, expiresAt: event.timestamp + 600_000, originalText: text, targetId: target.id });
    return { text: `請在 10 分鐘內重新描述完整交易 #${target.sequence}。` };
  }
  const categoryMatch = text.match(/^分類 ([\w-]+) (.+)$/);
  if (categoryMatch) {
    const selectedSmallCategory = categoryMatch[2] ?? "";
    const pending = state.pending.find((item) => item.id === categoryMatch[1] && item.actorId === event.source.userId && item.expiresAt >= event.timestamp);
    const category = Object.entries(CATEGORIES).find(([, values]) => values.includes(selectedSmallCategory as never));
    if (!pending?.transactions || !category) return { text: "分類選擇已失效或不正確。" };
    const unresolvedIndex = pending.transactions.findIndex((transaction) => transaction.type === "expense" && !transaction.smallCategory);
    // A category selection applies to one unresolved expense, never to the entire batch.
    const selectedIndex = unresolvedIndex >= 0 ? unresolvedIndex : pending.transactions.length === 1 ? 0 : -1;
    if (selectedIndex < 0) return { text: "請重新輸入並指定需要調整分類的交易。" };
    const transaction = pending.transactions[selectedIndex]!;
    transaction.majorCategory = category[0];
    transaction.smallCategory = selectedSmallCategory;
    const note = expenseNote(transaction.note ?? "", transaction);
    if (note) transaction.note = note;
    else delete transaction.note;
    const next = pending.transactions.find((item) => item.type === "expense" && !item.smallCategory);
    if (next) pending.choices = unresolvedCategoryChoices(next);
    else delete pending.choices;
    return candidateReply(pending, state);
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
    if (target && pending.operation === "replace" && pending.transactions?.length === 1 && pending.transactions[0]) {
      learnCategoryRule(state, target, pending.transactions[0], event.timestamp);
    }
    if (target && (pending.operation === "void" || pending.operation === "replace")) voidEntry(state, target, { id: event.webhookEventId, timestamp: event.timestamp, originalText: pending.originalText });
    for (const transaction of pending.transactions ?? []) {
      const entry = addEntry(state, transaction, { actorId: event.source.userId, originalText: pending.originalText, eventId: event.webhookEventId, now: event.timestamp });
      if (transaction.type === "contribution") {
        const fundMonth = monthState(state, monthOf(transaction.date));
        fundMonth.confirmations[event.source.userId] = { amount: transaction.amount, entryId: entry.id };
        if (fundMonth.status !== "closed" && [...allowedUsers(env)].every((userId) => fundMonth.confirmations[userId])) {
          fundMonth.status = "active";
          state.thresholdBands[fundMonth.month] = balanceBand(balance(state));
        }
      }
    }
    state.pending = state.pending.filter((item) => item.id !== pending.id);
    if (pending.kind === "closed_month") await recomputeClosedMonths(state, pending.effectiveMonth ?? monthOf(pending.transactions?.[0]?.date ?? target?.date ?? eventDate(event.timestamp)));
    return pending.transactions?.length ? receipt(pending.transactions, state) : { text: `已作廢交易，目前餘額：${money(balance(state))}` };
  }
  const deleteId = text.match(/^刪除 ([\w-]+)$/)?.[1];
  if (deleteId) {
    const target = activeEntries(state).find((entry) => entry.id === deleteId && entry.actorId === event.source.userId);
    if (!target) return { text: "找不到你可刪除的交易。" };
    if (state.months[monthOf(target.date)]?.status === "closed") {
      const id = crypto.randomUUID();
      const pending: PendingOperation = { id, kind: "closed_month", operation: "void", actorId: event.source.userId, groupId: event.source.groupId, expiresAt: event.timestamp + 300_000, originalText: text, targetId: target.id, effectiveMonth: monthOf(target.date) };
      state.pending.push(pending);
      return closedMonthDeletionReply(pending, target, state);
    }
    voidEntry(state, target, { id: event.webhookEventId, timestamp: event.timestamp, originalText: text });
    return { text: `已作廢 #${target.sequence}，目前餘額：${money(balance(state))}` };
  }
  const date = eventDate(event.timestamp);
  const usageDay = date;
  const used = state.geminiUsage[usageDay] ?? 0;
  const locallyParsed = preparedParse?.kind === "local";
  if (!locallyParsed && (preparedParse?.kind === "quota" || used >= Number(env.GEMINI_DAILY_LIMIT))) return { text: "今日 AI 免費額度已用完；精確查詢指令仍可使用。" };
  if (!locallyParsed) state.geminiUsage[usageDay] = used + 1;
  let parsed;
  if (preparedParse?.kind === "failure") {
    const id = crypto.randomUUID();
    state.pending.push({ id, kind: "retry", actorId: event.source.userId, groupId: event.source.groupId, expiresAt: event.timestamp + 600_000, originalText: text });
    return retryReply(id);
  } else if (preparedParse?.kind === "result" || preparedParse?.kind === "local") {
    parsed = preparedParse.result;
  } else {
    try {
      parsed = await providers.parse(text, { eventDate: date, categories: CATEGORIES });
    } catch {
      const id = crypto.randomUUID();
      state.pending.push({ id, kind: "retry", actorId: event.source.userId, groupId: event.source.groupId, expiresAt: event.timestamp + 600_000, originalText: text });
      return retryReply(id);
    }
  }
  parsed = normalizeTransactions(text, parsed, date);
  if (parsed.intent === "zero_contribution") {
    const month = monthState(state, monthOf(date));
    month.confirmations[event.source.userId] = { amount: 0 };
    if ([...allowedUsers(env)].every((userId) => month.confirmations[userId])) {
      month.status = "active";
      state.thresholdBands[month.month] = balanceBand(balance(state));
    }
    return balanceReply(state, event.timestamp, env);
  }
  if (parsed.intent === "query") {
    if (parsed.query === "balance") return balanceReply(state, event.timestamp, env);
    if (parsed.query === "recent") return processText(event, "最近紀錄", state, providers, env, store);
    if (parsed.query === "month_detail") return processText(event, "本月明細", state, providers, env, store);
    return { text: "無法判斷你想查詢的內容。" };
  }
  if (parsed.intent !== "transactions" || parsed.transactions.length === 0) return { text: "無法判斷為可入帳內容，尚未入帳。" };
  const invalidBase = parsed.transactions.some((transaction) => !Number.isInteger(transaction.amount) || transaction.amount <= 0 || !isCalendarDate(transaction.date) || transaction.date > date);
  if (invalidBase) return { text: "交易金額或日期無效，尚未入帳。" };
  const hasExpense = parsed.transactions.some((transaction) => transaction.type === "expense");
  const hasContribution = parsed.transactions.some((transaction) => transaction.type === "contribution" || transaction.type === "topup");
  if (hasExpense && hasContribution) return { text: "請將存入與支出分開輸入，以免帳務紀錄錯誤。" };
  const pendingEditForCandidate = state.pending.find((item) => item.kind === "edit" && item.actorId === event.source.userId && item.expiresAt >= event.timestamp);
  const pendingEditTarget = pendingEditForCandidate?.targetId
    ? activeEntries(state).find((entry) => entry.id === pendingEditForCandidate.targetId && entry.actorId === event.source.userId)
    : undefined;
  const candidateClosedMonth = earliestClosedMonth(state, parsed.transactions, pendingEditTarget);
  if (parsed.ambiguous || parsed.transactions.some((transaction) => transaction.amount >= 10_000)) {
    const id = crypto.randomUUID();
    if (pendingEditForCandidate) state.pending = state.pending.filter((item) => item.id !== pendingEditForCandidate.id);
    const pending: PendingOperation = {
      id, kind: candidateClosedMonth ? "closed_month" : "candidate", actorId: event.source.userId, groupId: event.source.groupId, expiresAt: event.timestamp + 600_000, originalText: text, transactions: parsed.transactions,
      ...(parsed.categoryChoices ? { choices: parsed.categoryChoices } : {}),
      ...(pendingEditForCandidate?.targetId ? { targetId: pendingEditForCandidate.targetId, operation: "replace" as const } : {}),
      ...(candidateClosedMonth ? { effectiveMonth: candidateClosedMonth } : {}),
    };
    state.pending.push(pending);
    return candidateReply(pending, state);
  }
  if (parsed.transactions.some((transaction) => !validTransaction(transaction, date))) return { text: "交易欄位不完整或無效，尚未入帳。" };
  const pendingEdit = state.pending.find((item) => item.kind === "edit" && item.actorId === event.source.userId && item.expiresAt >= event.timestamp);
  if (pendingEdit?.targetId) {
    const target = activeEntries(state).find((entry) => entry.id === pendingEdit.targetId && entry.actorId === event.source.userId);
    if (!target) return { text: "原交易已不存在，未修改。" };
    const affectedClosedMonth = earliestClosedMonth(state, parsed.transactions, target);
    if (affectedClosedMonth) {
      const id = crypto.randomUUID();
      state.pending = state.pending.filter((item) => item.id !== pendingEdit.id);
      const pending: PendingOperation = { id, kind: "closed_month", operation: "replace", actorId: event.source.userId, groupId: event.source.groupId, expiresAt: event.timestamp + 300_000, originalText: text, targetId: target.id, transactions: parsed.transactions, effectiveMonth: affectedClosedMonth };
      state.pending.push(pending);
      return candidateReply(pending, state);
    }
    const id = crypto.randomUUID();
    state.pending = state.pending.filter((item) => item.id !== pendingEdit.id);
    const candidate: PendingOperation = {
      id,
      kind: "candidate",
      operation: "replace",
      actorId: event.source.userId,
      groupId: event.source.groupId,
      expiresAt: event.timestamp + 600_000,
      originalText: text,
      targetId: target.id,
      transactions: parsed.transactions,
    };
    state.pending.push(candidate);
    return candidateReply(candidate, state);
  }
  const closedMonth = earliestClosedMonth(state, parsed.transactions);
  if (closedMonth) {
    const id = crypto.randomUUID();
    const pending: PendingOperation = { id, kind: "closed_month", actorId: event.source.userId, groupId: event.source.groupId, expiresAt: event.timestamp + 300_000, originalText: text, transactions: parsed.transactions, effectiveMonth: closedMonth };
    state.pending.push(pending);
    return candidateReply(pending, state);
  }
  const beforeBalance = balance(state);
  const duplicateContribution = parsed.transactions.find((transaction) => transaction.type === "contribution" && monthState(state, monthOf(transaction.date)).confirmations[event.source.userId]);
  if (duplicateContribution) {
    const id = crypto.randomUUID();
    state.pending.push({ id, kind: "contribution_choice", actorId: event.source.userId, groupId: event.source.groupId, expiresAt: event.timestamp + 600_000, originalText: text, transactions: [duplicateContribution], choices: ["修改原申報", "額外補入"] });
    const existing = monthState(state, monthOf(duplicateContribution.date)).confirmations[event.source.userId]?.amount ?? 0;
    const buttons = ["修改原申報", "額外補入"].map((choice, index) => ({ type: "button", style: index === 0 ? "primary" : "secondary", ...(index === 0 ? { color: "#2E7D32" } : {}), margin: index === 0 ? "lg" : "sm", action: { type: "postback", label: choice, data: `action=contribution&id=${id}&value=${encodeURIComponent(choice)}`, displayText: choice } }));
    const responseText = `本月已有存入紀錄：${money(existing)}\n本次存入：${money(duplicateContribution.amount)}\n請選擇「修改原申報」或「額外補入」。`;
    return { text: responseText, flex: { type: "bubble", body: { type: "box", layout: "vertical", contents: [
      { type: "text", text: "本月已有存入", weight: "bold", size: "xl" },
      { type: "text", text: "請選擇本次金額的處理方式", color: "#777777", size: "sm", margin: "sm" },
      { type: "separator", margin: "md" },
      { type: "box", layout: "horizontal", margin: "md", contents: [
        { type: "text", text: "原存入金額", flex: 3, color: "#777777", size: "sm" },
        { type: "text", text: money(existing), flex: 2, align: "end", weight: "bold", size: "sm" },
      ] },
      { type: "box", layout: "horizontal", margin: "md", contents: [
        { type: "text", text: "本次存入金額", flex: 3, color: "#777777", size: "sm" },
        { type: "text", text: money(duplicateContribution.amount), flex: 2, align: "end", weight: "bold", size: "sm", color: "#2E7D32" },
      ] },
      ...buttons,
    ] } } };
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
    async fetch(request, env, context) {
      if (request.method === "GET" && new URL(request.url).pathname.startsWith("/charts/")) return providers.serveChart(request);
      if (request.method === "GET" && new URL(request.url).pathname.startsWith("/exports/")) return serveCsvExport(request, store, env);
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
      const notifyOperationalError = async (groupId: string, errorCode: string): Promise<void> => {
        try {
          if (await providers.pushAllowance() < 2) return;
          const shouldNotify = await store.withGroupLock(groupId, async () => {
            const state = await store.loadState(groupId);
            state.errorNotifications ??= {};
            const now = Date.now();
            if ((state.errorNotifications[errorCode] ?? 0) > now - 60 * 60 * 1000) return false;
            state.errorNotifications[errorCode] = now;
            await store.saveState(state);
            return true;
          });
          if (!shouldNotify) return;
          const label = ERROR_LABELS[errorCode] ?? "系統處理失敗";
          await providers.push(groupId, { text: `系統提醒：偵測到${label}。帳本不會自動重複入帳，可輸入「系統狀態」查看。` });
        } catch {
          // Operational alerts must never change or retry accounting work.
        }
      };
      const deliverReply = async (
        event: LineEvent & { source: { groupId: string; userId: string; type: "group" } },
        response: ReplyMessage,
      ): Promise<void> => {
        const finishDeliveredEvents = async (): Promise<void> => {
          await store.finishEvent(event.webhookEventId, "posted");
          for (const recoveredEventId of response.pendingEventIds ?? []) {
            if (recoveredEventId !== event.webhookEventId) await store.finishEvent(recoveredEventId, "posted");
          }
        };
        try {
          await providers.reply(event.replyToken ?? "", response);
          await finishDeliveredEvents();
        } catch {
          try {
            await providers.push(event.source.groupId, response);
            await finishDeliveredEvents();
            return;
          } catch {
            // Preserve the response for the next successful interaction.
          }
          try {
            await store.withGroupLock(event.source.groupId, async () => {
              const state = await store.loadState(event.source.groupId);
              state.pendingReceipts ??= [];
              state.pendingReceipts.push({
                ...response,
                pendingEventIds: [...new Set([...(response.pendingEventIds ?? []), event.webhookEventId])],
              });
              await store.saveState(state);
            });
            await store.finishEvent(event.webhookEventId, "reply_pending", "line_reply_failed");
            await notifyOperationalError(event.source.groupId, "line_reply_failed");
          } catch (error) {
            const errorCode = classifyError(error);
            await store.finishEvent(event.webhookEventId, "failed_retryable", errorCode);
            await notifyOperationalError(event.source.groupId, errorCode);
          }
        }
      };
      const prepareLockFreeReply = async (
        event: LineEvent & { source: { groupId: string; userId: string; type: "group" } },
        command: string,
        snapshot: GroupState,
      ): Promise<ReplyMessage | undefined> => {
        if (snapshot.suspended) return undefined;
        await cacheMemberNames(snapshot, event.source.groupId, env, providers);
        const response = await processText(event, command, snapshot, providers, env, store);
        return store.withGroupLock(event.source.groupId, async () => {
          const state = await store.loadState(event.source.groupId);
          state.memberNames = { ...(state.memberNames ?? {}), ...(snapshot.memberNames ?? {}) };
          state.pendingReceipts ??= [];
          attachPendingReceipts(response, state);
          await store.saveState(state);
          return response;
        });
      };
      const processEvents = async (): Promise<void> => {
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
          expiresAt: event.timestamp + 30 * 86_400_000,
        });
        if (!inserted) continue;
        try {
          if (event.type === "message" && event.message?.type === "text" && event.message.text && event.replyToken) {
            const messageText = event.message.text;
            const preflightState = await store.loadState(event.source.groupId);
            if (LOCK_FREE_COMMANDS.has(messageText)) {
              const response = await prepareLockFreeReply(event, messageText, preflightState);
              if (response) await deliverReply(event, response);
              else await store.finishEvent(event.webhookEventId, "failed_final", "group_suspended");
              continue;
            }
            await cacheMemberNames(preflightState, event.source.groupId, env, providers);
            const alreadyPosted = activeEntries(preflightState).some((entry) => entry.eventId === event.webhookEventId);
            const preparedParse = needsGemini(messageText) && !preflightState.suspended && !alreadyPosted
              ? await prepareParse(messageText, preflightState, event.timestamp, providers, env)
              : undefined;
            const response = await store.withGroupLock(event.source.groupId, async () => {
              const state = await store.loadState(event.source.groupId);
              state.memberNames = { ...(state.memberNames ?? {}), ...(preflightState.memberNames ?? {}) };
              if (state.suspended) {
                return undefined;
              }
              const response = await processText(event, messageText, state, providers, env, store, preparedParse);
              attachPendingReceipts(response, state);
              await store.saveState(state);
              return response;
            });
            if (response) await deliverReply(event, response);
            else await store.finishEvent(event.webhookEventId, "failed_final", "group_suspended");
          } else if (event.type === "postback" && event.postback?.data && event.replyToken) {
            const params = new URLSearchParams(event.postback.data);
            const action = params.get("action");
            const id = params.get("id");
            const command = action === "chart" || action === "detail" || action === "menu"
              ? params.get("value") ?? ""
              : action === "page"
                ? `${params.get("view") ?? ""} 第${params.get("page") ?? "1"}頁`
              : action && id
                ? action === "edit" ? `編輯 ${id}`
                : action === "delete" ? `刪除 ${id}`
                  : action === "confirm" ? `確認 ${id}`
                    : action === "cancel" ? `取消 ${id}`
                      : action === "category" ? `分類 ${id} ${params.get("value") ?? ""}`
                      : action === "contribution" ? `存入選擇 ${id} ${params.get("value") ?? ""}`
                        : action === "retry" ? `重試 ${id}`
                      : ""
                : "";
            const preflightState = await store.loadState(event.source.groupId);
            if (LOCK_FREE_COMMANDS.has(command)) {
              const response = await prepareLockFreeReply(event, command, preflightState);
              if (response) await deliverReply(event, response);
              else await store.finishEvent(event.webhookEventId, "failed_final", "invalid_command");
              continue;
            }
            await cacheMemberNames(preflightState, event.source.groupId, env, providers);
            const response = await store.withGroupLock(event.source.groupId, async () => {
              const state = await store.loadState(event.source.groupId);
              state.memberNames = { ...(state.memberNames ?? {}), ...(preflightState.memberNames ?? {}) };
              const response = await processText(event, command, state, providers, env, store);
              attachPendingReceipts(response, state);
              await store.saveState(state);
              return response;
            });
            if (response) await deliverReply(event, response);
            else await store.finishEvent(event.webhookEventId, "failed_final", "invalid_command");
          } else if (event.type === "message" && event.replyToken) {
            await providers.reply(event.replyToken, { text: "目前只支援文字記帳。" });
            await store.finishEvent(event.webhookEventId, "posted");
          } else {
            await store.finishEvent(event.webhookEventId, "failed_final", "unsupported_event");
          }
        } catch (error) {
          const errorCode = classifyError(error);
          await store.finishEvent(event.webhookEventId, "failed_retryable", errorCode);
          await notifyOperationalError(event.source.groupId, errorCode);
        }
      }
      };
      if (context) {
        context.waitUntil(processEvents());
        return new Response("OK");
      }
      await processEvents();
      return new Response("OK");
    },
    async scheduled(event, env) {
      await store.withGroupLock(env.ALLOWED_GROUP_ID, async () => {
      const state = await store.loadState(env.ALLOWED_GROUP_ID);
      await cacheMemberNames(state, env.ALLOWED_GROUP_ID, env, providers);
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
          state.sentJobs.push(jobId);
          if (await providers.pushAllowance() >= 2) {
            const entries = activeEntries(state).filter((entry) => monthOf(entry.date) === month);
            const contributions = entries.filter((entry) => entry.type === "contribution").reduce((sum, entry) => sum + entry.amount, 0);
            const topups = entries.filter((entry) => entry.type === "topup").reduce((sum, entry) => sum + entry.amount, 0);
            const otherIncome = entries.filter((entry) => entry.type === "income" || entry.type === "refund").reduce((sum, entry) => sum + entry.amount, 0);
            const expenses = entries.filter((entry) => entry.type === "expense").reduce((sum, entry) => sum + entry.amount, 0);
            const totals = categoryTotals(state, month);
            const largestIndex = totals.reduce((best, value, index) => value > (totals[best] ?? -Infinity) ? index : best, 0);
            const largestCategory = Object.keys(CATEGORIES)[largestIndex] ?? "無";
            const missing = [...allowedUsers(env)].filter((userId) => !fundMonth.confirmations[userId]);
            await providers.push(env.ALLOWED_GROUP_ID, monthCloseReply({
              month,
              contributions,
              topups,
              otherIncome,
              expenses,
              largestCategory,
              closingBalance: fundMonth.closingBalance,
              missingNames: missing.map((userId) => memberDisplayName(state, userId, env)),
            }));
          }
        }
      } else if ((day === 1 || day === 3) && hour === 9 && minute === 0) {
        const month = monthOf(eventDate(event.scheduledTime));
        const fundMonth = monthState(state, month);
        const missing = [...allowedUsers(env)].filter((userId) => !fundMonth.confirmations[userId]);
        const jobId = `reminder:${month}:${day}`;
        if (missing.length > 0 && !state.sentJobs.includes(jobId) && await providers.pushAllowance() >= 2) {
          const missingNames = missing.map((userId) => memberDisplayName(state, userId, env));
          await providers.push(env.ALLOWED_GROUP_ID, { text: `共同基金存入提醒：${missingNames.join("、")} 尚未確認。` });
          state.sentJobs.push(jobId);
        }
      }
      await store.cleanup(event.scheduledTime);
      await store.saveState(state);
      });
    },
  };
}
