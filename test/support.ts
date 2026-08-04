import { lineSignature } from "../src/security";
import { emptyState } from "../src/domain";
import type { AppEnv, ChartData, EventRecord, GroupState, ParseContext, ParseResult, Providers, ReplyMessage, Store } from "../src/types";

export class MemoryStore implements Store {
  readonly events: EventRecord[] = [];
  readonly states = new Map<string, GroupState>();
  private readonly locks = new Map<string, Promise<void>>();

  async beginEvent(record: EventRecord): Promise<boolean> {
    if (this.events.some((event) => event.id === record.id)) return false;
    this.events.push(structuredClone(record));
    return true;
  }

  async finishEvent(id: string, status: EventRecord["status"]): Promise<void> {
    const event = this.events.find((candidate) => candidate.id === id);
    if (event) event.status = status;
  }

  async loadState(groupId: string): Promise<GroupState> {
    return structuredClone(this.states.get(groupId) ?? emptyState(groupId));
  }

  async saveState(state: GroupState): Promise<void> {
    this.states.set(state.groupId, structuredClone(state));
  }

  async cleanup(beforeTimestamp: number): Promise<void> {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      if ((this.events[index]?.expiresAt ?? Infinity) < beforeTimestamp) this.events.splice(index, 1);
    }
  }

  async withGroupLock<T>(groupId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(groupId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(groupId, previous.then(() => current));
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(groupId) === current) this.locks.delete(groupId);
    }
  }
}

export class TestProviders implements Providers {
  readonly env: AppEnv = {
    LINE_CHANNEL_SECRET: "test-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "test-token",
    ALLOWED_GROUP_ID: "GROUP",
    ALLOWED_USER_IDS: "SPOUSE_A,SPOUSE_B",
    TIME_ZONE: "Asia/Taipei",
    GEMINI_DAILY_LIMIT: "100",
    LINE_PUSH_MONTHLY_LIMIT: "200",
  };
  readonly replies: Array<ReplyMessage & { token: string }> = [];
  readonly pushes: Array<ReplyMessage & { groupId: string }> = [];
  readonly parses: ParseResult[] = [];
  readonly geminiInputs: string[] = [];
  readonly uploads: Array<{ month: string; csv: string; existingFileId?: string }> = [];
  readonly charts: Array<{ kind: string; data: ChartData }> = [];
  allowance = 200;

  async reply(token: string, message: ReplyMessage): Promise<void> {
    this.replies.push({ ...message, token });
  }

  async push(groupId: string, message: ReplyMessage): Promise<void> {
    this.pushes.push({ ...message, groupId });
  }


  async parse(text: string, _context: ParseContext): Promise<ParseResult> {
    this.geminiInputs.push(text);
    return this.parses.shift() ?? { intent: "unknown" };
  }


  async uploadCsv(month: string, csv: string, existingFileId?: string): Promise<string> {
    this.uploads.push(existingFileId ? { month, csv, existingFileId } : { month, csv });
    return existingFileId ?? `drive-${month}`;
  }

  async chart(kind: "month" | "monthly-trend" | "category-trend", data: ChartData): Promise<string> {
    this.charts.push({ kind, data });
    return `https://worker.test/charts/signed-${kind}`;
  }

  async pushAllowance(): Promise<number> {
    return this.allowance;
  }

  async serveChart(_request: Request): Promise<Response> {
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
  }
}

export async function signedLineRequest(
  text: string,
  overrides: { eventId?: string; userId?: string; groupId?: string; signature?: string; timestamp?: number } = {},
): Promise<Request> {
  const payload = JSON.stringify({
    destination: "BOT",
    events: [{
      type: "message",
      webhookEventId: overrides.eventId ?? crypto.randomUUID(),
      timestamp: overrides.timestamp ?? Date.UTC(2026, 7, 4, 4),
      replyToken: crypto.randomUUID(),
      source: { type: "group", groupId: overrides.groupId ?? "GROUP", userId: overrides.userId ?? "SPOUSE_A" },
      message: { id: crypto.randomUUID(), type: "text", text },
    }],
  });
  const signature = overrides.signature ?? await lineSignature("test-secret", payload);
  return new Request("https://worker.test/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": signature },
    body: payload,
  });
}

export async function signedWebhookEvent(event: Record<string, unknown>): Promise<Request> {
  const payload = JSON.stringify({ destination: "BOT", events: [event] });
  return new Request("https://worker.test/webhook", { method: "POST", headers: { "content-type": "application/json", "x-line-signature": await lineSignature("test-secret", payload) }, body: payload });
}
