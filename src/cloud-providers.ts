import { CATEGORIES } from "./domain";
import { lineSignature } from "./security";
import type { ChartData, CloudEnv, ParseContext, ParseResult, Providers, ReplyMessage } from "./types";

function lineMessage(message: ReplyMessage): Record<string, unknown> {
  if (!message.flex) return { type: "text", text: message.text };
  const suppliedContents = message.flex.type === "bubble" && message.flex.body ? message.flex : undefined;
  return {
    type: "flex",
    altText: message.text.slice(0, 400),
    contents: suppliedContents ?? {
      type: "bubble",
      body: { type: "box", layout: "vertical", contents: [{ type: "text", text: message.text, wrap: true, size: "sm" }] },
    },
  };
}

async function jsonRequest(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Provider request failed: ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

export class CloudProviders implements Providers {
  constructor(readonly env: CloudEnv) {}

  async reply(token: string, message: ReplyMessage): Promise<void> {
    await jsonRequest("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: { authorization: `Bearer ${this.env.LINE_CHANNEL_ACCESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ replyToken: token, messages: [lineMessage(message)] }),
    });
  }

  async push(groupId: string, message: ReplyMessage): Promise<void> {
    await jsonRequest("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { authorization: `Bearer ${this.env.LINE_CHANNEL_ACCESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ to: groupId, messages: [lineMessage(message)] }),
    });
  }

  async pushAllowance(): Promise<number> {
    const [quota, consumption] = await Promise.all([
      jsonRequest("https://api.line.me/v2/bot/message/quota", { headers: { authorization: `Bearer ${this.env.LINE_CHANNEL_ACCESS_TOKEN}` } }),
      jsonRequest("https://api.line.me/v2/bot/message/quota/consumption", { headers: { authorization: `Bearer ${this.env.LINE_CHANNEL_ACCESS_TOKEN}` } }),
    ]);
    const limit = quota.type === "limited" ? Number(quota.value ?? 0) : Number(this.env.LINE_PUSH_MONTHLY_LIMIT);
    return Math.max(0, Math.min(limit, Number(this.env.LINE_PUSH_MONTHLY_LIMIT)) - Number(consumption.totalUsage ?? 0));
  }

  async parse(text: string, context: ParseContext): Promise<ParseResult> {
    if (!this.env.GEMINI_API_KEY) throw new Error("Missing Gemini key");
    const model = this.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";
    const prompt = [
      "你是共同基金記帳解析器。只輸出符合 schema 的 JSON。不要猜測不明確欄位。",
      `事件日期：${context.eventDate}；幣別只允許 TWD 整數；未寫日期使用事件日期；未來日期無效。`,
      `分類：${JSON.stringify(CATEGORIES)}`,
      `輸入：${text}`,
    ].join("\n");
    const result = await jsonRequest(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(this.env.GEMINI_API_KEY)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });
    const candidates = result.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
    const output = candidates?.[0]?.content?.parts?.[0]?.text;
    if (!output) return { intent: "unknown" };
    return JSON.parse(output) as ParseResult;
  }

  private async driveAccessToken(): Promise<string> {
    if (!this.env.GOOGLE_CLIENT_ID || !this.env.GOOGLE_CLIENT_SECRET || !this.env.GOOGLE_REFRESH_TOKEN) throw new Error("Missing Google OAuth secrets");
    const response = await jsonRequest("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.env.GOOGLE_CLIENT_ID, client_secret: this.env.GOOGLE_CLIENT_SECRET, refresh_token: this.env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" }),
    });
    return String(response.access_token);
  }

  async uploadCsv(month: string, csv: string, existingFileId?: string): Promise<string> {
    const token = await this.driveAccessToken();
    if (existingFileId) {
      const response = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingFileId)}?uploadType=media`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "text/csv; charset=utf-8" }, body: csv });
      if (!response.ok) throw new Error(`Drive update failed: ${response.status}`);
      return existingFileId;
    }
    const boundary = `codex-${crypto.randomUUID()}`;
    const metadata = JSON.stringify({ name: `共同基金_${month}.csv`, mimeType: "text/csv", ...(this.env.GOOGLE_DRIVE_FOLDER_ID ? { parents: [this.env.GOOGLE_DRIVE_FOLDER_ID] } : {}) });
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/csv; charset=UTF-8\r\n\r\n${csv}\r\n--${boundary}--`;
    const response = await jsonRequest("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` }, body });
    return String(response.id);
  }

  async chart(kind: "month" | "monthly-trend" | "category-trend", data: ChartData): Promise<string> {
    if (!this.env.CHART_SIGNING_SECRET || !this.env.PUBLIC_BASE_URL) throw new Error("Missing chart configuration");
    const token = crypto.randomUUID();
    const expiresAt = Date.now() + 7 * 86_400_000;
    const config = chartConfig(kind, data);
    await this.env.DB.prepare("INSERT INTO chart_tokens (token, chart_json, expires_at) VALUES (?, ?, ?)").bind(token, JSON.stringify(config), expiresAt).run();
    const signature = await lineSignature(this.env.CHART_SIGNING_SECRET, `${token}.${expiresAt}`);
    return `${this.env.PUBLIC_BASE_URL}/charts/${token}?expires=${expiresAt}&signature=${encodeURIComponent(signature)}`;
  }

  async serveChart(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.pathname.split("/").at(-1) ?? "";
    const expiresAt = Number(url.searchParams.get("expires"));
    const signature = url.searchParams.get("signature") ?? "";
    if (!this.env.CHART_SIGNING_SECRET || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return new Response("Not found", { status: 404 });
    const expected = await lineSignature(this.env.CHART_SIGNING_SECRET, `${token}.${expiresAt}`);
    if (expected !== signature) return new Response("Not found", { status: 404 });
    const row = await this.env.DB.prepare("SELECT chart_json, expires_at FROM chart_tokens WHERE token = ?").bind(token).first<{ chart_json: string; expires_at: number }>();
    if (!row || row.expires_at !== expiresAt) return new Response("Not found", { status: 404 });
    const response = await fetch("https://quickchart.io/chart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ width: 900, height: 600, format: "png", backgroundColor: "white", chart: JSON.parse(row.chart_json) }) });
    if (!response.ok) return new Response("Chart unavailable", { status: 503 });
    return new Response(response.body, { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
  }
}

function chartConfig(kind: string, data: ChartData): Record<string, unknown> {
  const type = kind === "month" ? "horizontalBar" : "bar";
  return {
    type,
    data: { labels: data.labels, datasets: data.datasets.map((dataset, index) => ({ label: dataset.label, data: dataset.values, backgroundColor: ["#FF8A65", "#4DB6AC", "#7986CB", "#FFD54F", "#BA68C8"][index % 5] })) },
    options: { responsive: false, legend: { display: kind !== "month" }, scales: { yAxes: [{ stacked: kind === "category-trend", ticks: { beginAtZero: true } }], xAxes: [{ stacked: kind === "category-trend", ticks: { beginAtZero: true } }] } },
  };
}
