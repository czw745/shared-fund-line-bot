import { CATEGORIES } from "./domain";
import type { ParsedTransaction, ParseResult } from "./types";

export interface TransactionSource {
  amount: number;
  date: string;
  description: string;
}

function chineseNumber(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = "零一二三四五六七八九";
  if (value.includes("十")) {
    const [tens, units] = value.split("十");
    return (tens ? digits.indexOf(tens) : 1) * 10 + (units ? digits.indexOf(units) : 0);
  }
  return digits.indexOf(value);
}

function datePrefix(text: string, eventDate: string): { date: string; rest: string } | undefined {
  const relative = text.match(/^(今天|今日|昨天|昨日|前天)/);
  if (relative) {
    const days = /今天|今日/.test(relative[0]) ? 0 : relative[0] === "前天" ? 2 : 1;
    const date = new Date(Date.parse(`${eventDate}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
    return { date, rest: text.slice(relative[0].length).trim() };
  }
  const numeric = text.match(/^(?:(\d{4})[-/])?(\d{1,2})[-/](\d{1,2})(?!\d)/);
  const chinese = text.match(/^(?:(\d{4})年)?([\d一二三四五六七八九十]{1,3})月([\d一二三四五六七八九十]{1,3})(?:日|號)?/);
  const match = numeric ?? chinese;
  if (!match) return undefined;
  let year = Number(match[1] ?? eventDate.slice(0, 4));
  const suffix = `${String(chineseNumber(match[2]!)).padStart(2, "0")}-${String(chineseNumber(match[3]!)).padStart(2, "0")}`;
  // A yearless date denotes the most recent occurrence, per the ledger spec.
  if (!match[1] && `${year}-${suffix}` > eventDate) year -= 1;
  return { date: `${year}-${suffix}`, rest: text.slice(match[0].length).trim() };
}

/** Only recognize unambiguous, ordered amount/description segments; leave prose to Gemini. */
export function transactionSources(text: string, eventDate: string): TransactionSource[] | undefined {
  let date = eventDate;
  const sources: TransactionSource[] = [];
  // Commas in amounts (1,120) and before an amount (停車位，3500) are not separators.
  const segments = text.split(/[\n\r;；、]+|[,，](?=\s*[^\d\s])/u).map((part) => part.trim()).filter(Boolean);
  for (let segment of segments) {
    const prefix = datePrefix(segment, eventDate);
    if (prefix) {
      date = prefix.date;
      segment = prefix.rest.replace(/^[:：]\s*/, "");
    }
    if (!segment) continue;
    const number = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)";
    const suffix = segment.match(new RegExp(`(?:NT\\$|NTD|TWD|\\$)?\\s*(${number})\\s*元?\\s*$`, "i"));
    const leading = suffix ? undefined : segment.match(new RegExp(`^(?:NT\\$|NTD|TWD|\\$)?\\s*(${number})\\s*元?`, "i"));
    const amountMatch = suffix ?? leading;
    if (!amountMatch) return undefined;
    const amount = Number(amountMatch[1]!.replaceAll(",", ""));
    const description = (suffix ? segment.slice(0, suffix.index) : segment.slice(leading![0].length))
      .replace(/^[\s,，:：]+|[\s,，:：]+$/g, "");
    // Remaining bare numbers indicate another amount, an unsupported date, or invalid money.
    const nonQuantity = description.replace(/\d+\s*(?:瓶|包|盒|個|顆|份|組|入|件|杯|罐|袋)/g, "").replace(/3C|7-11/gi, "");
    if (!description || !Number.isSafeInteger(amount) || amount <= 0 || /\d|[+$€¥£]|美元|美金|日圓|人民幣/.test(nonQuantity)
      || /[.．-]\s*$/.test(description) || /^[.．-]/.test(description)
      || /(?:月|號|昨天|前天|明天|去年|上週|上周|上個月)/.test(description)) return undefined;
    sources.push({ amount, date, description });
  }
  return sources.length ? sources : undefined;
}

/** Parse explicit fund deposits locally so their accounting role never depends on AI output. */
export function parseFundDeposit(text: string, eventDate: string): ParseResult | undefined {
  const compact = text.replace(/\s+/g, "");
  const match = compact.match(/^((?:我)?(?:本月|這個月)?(?:存入|補入|額外補入|額外存入))(?:NT\$|NTD|TWD|\$)?(\d{1,3}(?:,\d{3})+|\d+)元?$/i);
  if (!match) return undefined;
  const description = match[1] ?? "";
  const amount = Number((match[2] ?? "").replaceAll(",", ""));
  if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
  const type = /^(?:我)?(?:本月|這個月)?存入$/.test(description)
    ? "contribution"
    : /^(?:我)?(?:本月|這個月)?(?:補入|額外補入|額外存入)$/.test(description)
      ? "topup"
      : undefined;
  if (!type) return undefined;
  return { intent: "transactions", transactions: [{ type, amount, date: eventDate }] };
}

const categoryPairs = Object.entries(CATEGORIES).flatMap(([major, smalls]) => smalls.map((small) => ({ major, small })));

function categoryPattern(category: string): RegExp {
  // Keep names such as 早餐店: that is a place, not an explicit meal selection.
  return new RegExp(`(?:^|[\\s／/])${category}(?!店|館|坊|屋)|${category}$`, "g");
}

function explicitCategory(description: string): { major: string; small: string } | undefined {
  const matches = categoryPairs.filter(({ small }) => categoryPattern(small).test(description));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Strip category labels, not the products, brands or purpose that justified a category. */
export function expenseNote(description: string, transaction: ParsedTransaction): string | undefined {
  let note = description.trim();
  if (transaction.type !== "expense") return note || undefined;
  for (const category of [transaction.smallCategory, transaction.majorCategory]) {
    if (category) note = note.replace(categoryPattern(category), " ").trim();
  }
  if (transaction.smallCategory === "停車費") note = note.replace(/^(?:停車)(?!位)|停車$/g, " ").trim();
  note = note.replace(/^[\s／/,，:：|｜]+|[\s／/,，:：|｜]+$/g, "").replace(/\s+/g, " ").trim();
  return note || undefined;
}

export function unresolvedCategoryChoices(transaction: ParsedTransaction): string[] {
  if (transaction.type !== "expense" || transaction.smallCategory) return [];
  if (transaction.majorCategory === "飲食") return ["早餐", "午餐", "晚餐"];
  return ["日用品", "零食", "午餐"];
}

/** Shared by local and AI parsing, before previews or ledger writes. */
export function normalizeTransactions(text: string, result: ParseResult, eventDate: string): ParseResult {
  if (result.intent !== "transactions") return result;
  const sources = transactionSources(text, eventDate);
  const aligned = sources?.length === result.transactions.length
    && sources.every((source, index) => source.amount === result.transactions[index]?.amount);
  let ambiguous = Boolean(result.ambiguous || (sources && !aligned));
  const transactions = result.transactions.map((original, index) => {
    const transaction = { ...original };
    const source = aligned ? sources?.[index] : undefined;
    if (source) transaction.date = source.date;
    if (transaction.type !== "expense") return transaction;
    if (source) {
      const explicit = explicitCategory(source.description);
      if (explicit) {
        transaction.majorCategory = explicit.major;
        transaction.smallCategory = explicit.small;
      } else if (/^(?:停車(?:費|位)?|車位)$/.test(source.description)) {
        transaction.majorCategory = "生活";
        transaction.smallCategory = "停車費";
      } else if (/^(?:生)?甜甜圈$/.test(source.description)) {
        transaction.majorCategory = "飲食";
        transaction.smallCategory = "甜點";
      } else if (/超市$/.test(source.description)) {
        delete transaction.majorCategory;
        delete transaction.smallCategory;
        ambiguous = true;
      } else if (transaction.majorCategory === "飲食" && ["早餐", "午餐", "晚餐"].includes(transaction.smallCategory ?? "")) {
        // Dish or shop alone cannot establish which meal it was.
        delete transaction.smallCategory;
        ambiguous = true;
      }
    }
    const note = expenseNote(source?.description ?? transaction.note ?? "", transaction);
    if (note) transaction.note = note;
    else delete transaction.note;
    if (!transaction.majorCategory || !transaction.smallCategory) ambiguous = true;
    return transaction;
  });
  const unresolved = transactions.find((transaction) => transaction.type === "expense" && !transaction.smallCategory);
  return {
    ...result, transactions,
    ...(ambiguous ? { ambiguous: true } : {}),
    ...(unresolved ? { categoryChoices: unresolvedCategoryChoices(unresolved) } : {}),
  };
}
