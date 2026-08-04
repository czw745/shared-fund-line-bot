import type { FundMonth, GroupState, LedgerEntry, ParsedTransaction } from "./types";

export const CATEGORIES = {
  "飲食": ["正餐", "飲料", "甜點", "零食"],
  "生活": ["房貸", "水電瓦斯", "網路", "修繕", "管理費", "停車費"],
  "交通": ["計程車", "汽車", "機車", "高鐵", "火車", "捷運"],
  "娛樂": ["電影", "影音", "門票", "聚會", "旅遊"],
  "購物": ["服飾", "3C", "家電", "香菸", "酒水", "玩具", "日用品"],
} as const;

export function emptyState(groupId: string): GroupState {
  return { groupId, sequence: 0, ledger: [], months: {}, pending: [], thresholdBands: {}, suspended: false, outsiderIds: [], geminiUsage: {}, sentJobs: [], pendingReceipts: [], driveFiles: {}, driveFailures: [] };
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function eventDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
}

export function validTransaction(transaction: ParsedTransaction, today: string): boolean {
  if (!Number.isInteger(transaction.amount) || transaction.amount <= 0 || transaction.date > today || !/^\d{4}-\d{2}-\d{2}$/.test(transaction.date)) return false;
  if (transaction.type === "expense" || (transaction.type === "refund" && !transaction.linkedTransactionId)) {
    const major = transaction.majorCategory as keyof typeof CATEGORIES;
    return Boolean(major && transaction.smallCategory && CATEGORIES[major]?.includes(transaction.smallCategory as never));
  }
  return true;
}

export function monthState(state: GroupState, month: string): FundMonth {
  state.months[month] ??= { month, status: "awaiting_contributions", confirmations: {}, openingBalance: openingBalance(state, month) };
  return state.months[month];
}

export function activeEntries(state: GroupState): LedgerEntry[] {
  const voided = new Set(state.ledger.filter((entry) => entry.status === "void" && entry.revisionOf).map((entry) => entry.revisionOf));
  return state.ledger.filter((entry) => entry.status === "active" && !voided.has(entry.id));
}

export function signedAmount(entry: Pick<LedgerEntry, "type" | "amount">): number {
  return entry.type === "expense" ? -entry.amount : entry.amount;
}

export function balance(state: GroupState, throughDate?: string): number {
  return activeEntries(state)
    .filter((entry) => !throughDate || entry.date <= throughDate)
    .reduce((total, entry) => total + signedAmount(entry), 0);
}

export function openingBalance(state: GroupState, month: string): number {
  const first = `${month}-01`;
  return activeEntries(state).filter((entry) => entry.date < first).reduce((total, entry) => total + signedAmount(entry), 0);
}

export function addEntry(state: GroupState, transaction: ParsedTransaction, meta: { actorId: string; originalText: string; eventId: string; now: number }): LedgerEntry {
  state.sequence += 1;
  const entry: LedgerEntry = {
    ...transaction,
    id: crypto.randomUUID(),
    sequence: state.sequence,
    actorId: meta.actorId,
    originalText: meta.originalText,
    createdAt: meta.now,
    eventId: meta.eventId,
    status: "active",
  };
  state.ledger.push(entry);
  return entry;
}

export function money(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}NT$${Math.abs(value).toLocaleString("en-US")}`;
}
