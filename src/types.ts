export interface AppEnv {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  ALLOWED_GROUP_ID: string;
  ALLOWED_USER_IDS: string;
  TIME_ZONE: string;
  GEMINI_API_KEY?: string;
  GEMINI_DAILY_LIMIT: string;
  LINE_PUSH_MONTHLY_LIMIT: string;
  CHART_SIGNING_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  GEMINI_MODEL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  GOOGLE_DRIVE_FOLDER_ID?: string;
}

export interface LineSource {
  type: "group";
  groupId: string;
  userId?: string;
}

export interface LineMessage {
  id: string;
  type: string;
  text?: string;
}

export interface LineEvent {
  type: string;
  webhookEventId: string;
  timestamp: number;
  replyToken?: string;
  source?: LineSource;
  message?: LineMessage;
  postback?: { data: string };
  joined?: { members: Array<{ type: string; userId?: string }> };
  left?: { members: Array<{ type: string; userId?: string }> };
}

export interface LineWebhook {
  destination: string;
  events: LineEvent[];
}

export interface ReplyMessage {
  text: string;
  flex?: Record<string, unknown>;
}

export interface Providers {
  env: AppEnv;
  reply(token: string, message: ReplyMessage): Promise<void>;
  push(groupId: string, message: ReplyMessage): Promise<void>;
  parse(text: string, context: ParseContext): Promise<ParseResult>;
  uploadCsv(month: string, csv: string, existingFileId?: string): Promise<string>;
  chart(kind: "month" | "monthly-trend" | "category-trend", data: ChartData): Promise<string>;
  pushAllowance(): Promise<number>;
  serveChart(request: Request): Promise<Response>;
}

export interface CloudEnv extends AppEnv {
  DB: D1Database;
}

export interface ChartData {
  labels: string[];
  datasets: Array<{ label: string; values: number[] }>;
  summary: string[];
}

export type TransactionType = "expense" | "contribution" | "topup" | "refund" | "income";

export interface ParsedTransaction {
  type: TransactionType;
  amount: number;
  date: string;
  majorCategory?: string;
  smallCategory?: string;
  note?: string;
  linkedTransactionId?: string;
}

export type ParseResult =
  | { intent: "transactions"; transactions: ParsedTransaction[]; ambiguous?: boolean; categoryChoices?: string[] }
  | { intent: "zero_contribution" }
  | { intent: "query"; query: string }
  | { intent: "unknown" };

export interface ParseContext {
  eventDate: string;
  categories: Record<string, readonly string[]>;
}

export interface LedgerEntry extends ParsedTransaction {
  id: string;
  sequence: number;
  actorId: string;
  originalText: string;
  createdAt: number;
  eventId: string;
  status: "active" | "void";
  revisionOf?: string;
}

export interface PendingOperation {
  id: string;
  kind: "candidate" | "edit" | "refund" | "closed_month" | "contribution_choice" | "retry";
  actorId: string;
  groupId: string;
  expiresAt: number;
  originalText: string;
  transactions?: ParsedTransaction[];
  targetId?: string;
  choices?: string[];
  operation?: "post" | "replace" | "void";
  effectiveMonth?: string;
}

export interface FundMonth {
  month: string;
  status: "awaiting_contributions" | "active" | "closed";
  confirmations: Record<string, { amount: number; entryId?: string }>;
  incomplete?: boolean;
  closedAt?: number;
  openingBalance: number;
  closingBalance?: number;
}

export interface GroupState {
  groupId: string;
  sequence: number;
  ledger: LedgerEntry[];
  months: Record<string, FundMonth>;
  pending: PendingOperation[];
  thresholdBands: Record<string, number>;
  suspended: boolean;
  outsiderIds: string[];
  geminiUsage: Record<string, number>;
  sentJobs: string[];
  pendingReceipts: ReplyMessage[];
  driveFiles: Record<string, string>;
  driveFailures: string[];
}

export interface EventRecord {
  id: string;
  groupId: string;
  userId: string;
  timestamp: number;
  status: "received" | "processing" | "posted" | "failed_retryable" | "failed_final" | "reply_pending";
  raw?: string;
  expiresAt?: number;
}

export interface Store {
  beginEvent(record: EventRecord): Promise<boolean>;
  finishEvent(id: string, status: EventRecord["status"]): Promise<void>;
  loadState(groupId: string): Promise<GroupState>;
  saveState(state: GroupState): Promise<void>;
  cleanup(beforeTimestamp: number): Promise<void>;
  withGroupLock<T>(groupId: string, action: () => Promise<T>): Promise<T>;
}

export interface WorkerApp {
  fetch(request: Request, env: AppEnv): Promise<Response>;
  scheduled?(event: ScheduledEvent, env: AppEnv): Promise<void>;
}
