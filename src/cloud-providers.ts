import { CATEGORIES } from "./domain";
import { validFlexContainer } from "./flex-validation";
import { lineSignature } from "./security";
import type { ChartData, CloudEnv, ParseContext, ParseResult, Providers, ReplyMessage } from "./types";

const CATEGORY_HINTS: Array<{ keywords: string[]; majorCategory: string; smallCategory: string }> = [
  { keywords: ["風倍清", "衛生紙", "洗衣精", "洗碗精", "清潔劑", "垃圾袋", "牙膏", "牙刷", "洗髮精", "沐浴乳"], majorCategory: "購物", smallCategory: "日用品" },
  { keywords: ["電扇", "風扇", "冰箱", "冷氣", "電視", "吹風機", "除濕機", "吸塵器"], majorCategory: "購物", smallCategory: "家電" },
];

function normalizeKnownProduct(text: string, result: ParseResult): ParseResult {
  if (result.intent !== "transactions" || result.transactions.length !== 1) return result;
  const transaction = result.transactions[0];
  if (!transaction || transaction.type !== "expense" || (transaction.majorCategory && transaction.smallCategory)) return result;
  const hint = CATEGORY_HINTS.find((candidate) => candidate.keywords.some((keyword) => text.includes(keyword)));
  if (!hint) return result;
  const note = transaction.note?.trim() || text.replace(/\s*\d[\d,]*\s*元?\s*$/, "").trim();
  return {
    intent: "transactions",
    transactions: [{ ...transaction, majorCategory: hint.majorCategory, smallCategory: hint.smallCategory, ...(note ? { note } : {}) }],
    ambiguous: false,
  };
}

function lineMessage(message: ReplyMessage): Record<string, unknown> {
  if (!message.flex) return { type: "text", text: message.text };
  const suppliedContents = message.flex.type === "bubble"
    ? (message.flex.body || message.flex.hero || message.flex.header || message.flex.footer ? message.flex : undefined)
    : message.flex.type === "carousel" && Array.isArray(message.flex.contents) && message.flex.contents.length > 0
      ? message.flex
      : undefined;
  if (!suppliedContents || !validFlexContainer(suppliedContents)) return { type: "text", text: message.text };
  return {
    type: "flex",
    altText: message.text.slice(0, 400),
    contents: suppliedContents,
  };
}

async function jsonRequest(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json() as { error?: { message?: string; status?: string } };
      detail = [payload.error?.status, payload.error?.message].filter(Boolean).join(": ");
    } catch {
      // Some providers return an empty or non-JSON error body.
    }
    throw new Error(`Provider request failed: ${response.status}${detail ? ` (${detail})` : ""}`);
  }
  return await response.json() as Record<string, unknown>;
}

export class CloudProviders implements Providers {
  constructor(readonly env: CloudEnv) {}

  async reply(token: string, message: ReplyMessage): Promise<void> {
    await jsonRequest("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
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

  async memberName(groupId: string, userId: string): Promise<string | undefined> {
    const profile = await jsonRequest(`https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${this.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    return typeof profile.displayName === "string" && profile.displayName.trim() ? profile.displayName.trim() : undefined;
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
    const model = this.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
    const prompt = [
      "你是共同基金記帳解析器。只輸出符合 schema 的 JSON。不要猜測不明確欄位。",
      "使用者表示當月／這個月存入某金額時，intent=transactions，type=contribution。",
      "使用者明確表示本月不存或存入 0 時，intent=zero_contribution，不建立 transactions。",
      "日常消費的 type=expense；額外補入的 type=topup；不支援退款，退款相關輸入必須回傳 intent=unknown。",
      "飲食若明確出現早餐、午餐或晚餐，smallCategory 必須使用對應時段；無法判斷時標記 ambiguous，不可猜測。",
      "多筆交易依原文順序輸出。日期由上往下承接：未寫日期的項目沿用前一個明確日期，空行不重設日期，直到出現新日期；第一個日期之前的項目才使用事件日期。日期可獨立成行。",
      "例：9/4 牛排 晚餐740\\n停車40\\n\\n9/5牛肉麵午餐380，日期依序為9/4、9/4、9/5。不得把後面的日期套用到前面的交易。",
      "備註只保存該筆扣除日期、金額、分類名稱與同義分類詞後的具體品項、店名、品牌、數量或用途，不可混入其他筆內容。不要把分類依據全部刪除。",
      "例：午餐鐵板麵260→飲食／午餐，note=鐵板麵；三哥晚餐240→飲食／晚餐，note=三哥；早餐264→飲食／早餐且無note；停車40→生活／停車費且無note。",
      "例：加油1120→交通／汽車，note=加油（明示機車則分類機車）；甜甜圈95→飲食／甜點，note=甜甜圈；電費、水費、瓦斯費歸生活／水電瓦斯但note各保留細項；uber保留品牌名。停車位或車位可保留以辨識用途。",
      "只有超市或LOPIA超市等店名時不能推定日用品或零食；只有牛肉麵、火鍋等品項時不能推定午餐或晚餐。缺少分類依據時保留描述並標記ambiguous，省略不確定的分類欄位，讓使用者補選或補充內容。",
      "常見商品分類：風倍清、衛生紙、洗衣精、洗碗精、清潔劑、垃圾袋、牙膏、洗髮精屬於購物／日用品；電扇、冰箱、冷氣、吹風機、除濕機、吸塵器屬於購物／家電。",
      "商品或品牌能由上述例子或一般常識唯一對應既有分類時，應填入 majorCategory、smallCategory、note，且 ambiguous=false；只有確實存在多個合理分類時才標記 ambiguous。",
      `事件日期：${context.eventDate}；幣別只允許 TWD 整數；整則訊息未寫日期使用事件日期；省略年份的月日取不晚於事件日期的最近一次；明示年份的未來日期無效。`,
      `分類：${JSON.stringify(CATEGORIES)}`,
      `輸入：${text}`,
    ].join("\n");
    const result = await jsonRequest(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(this.env.GEMINI_API_KEY)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: {
            type: "object",
            required: ["intent"],
            properties: {
              intent: { type: "string", enum: ["transactions", "zero_contribution", "query", "unknown"] },
              transactions: {
                type: "array",
                items: {
                  type: "object",
                  required: ["type", "amount", "date"],
                  properties: {
                    type: { type: "string", enum: ["expense", "contribution", "topup", "income"] },
                    amount: { type: "integer", minimum: 1 },
                    date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
                    majorCategory: { type: "string", enum: Object.keys(CATEGORIES) },
                    smallCategory: { type: "string", enum: Object.values(CATEGORIES).flat() },
                    note: { type: "string" },
                  },
                },
              },
              ambiguous: { type: "boolean" },
              categoryChoices: { type: "array", items: { type: "string", enum: Object.values(CATEGORIES).flat() } },
              query: { type: "string", enum: ["balance", "recent", "month_detail", "unknown"] },
            },
          },
        },
      }),
    });
    const candidates = result.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
    const output = candidates?.[0]?.content?.parts?.[0]?.text;
    if (!output) return { intent: "unknown" };
    return normalizeKnownProduct(text, JSON.parse(output) as ParseResult);
  }

  async chart(kind: "monthly-trend" | "category-trend", data: ChartData): Promise<string> {
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
    const response = await fetch("https://quickchart.io/chart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ width: 720, height: 900, devicePixelRatio: 2, format: "png", backgroundColor: "white", chart: JSON.parse(row.chart_json) }) });
    if (!response.ok) return new Response("Chart unavailable", { status: 503 });
    return new Response(response.body, { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
  }
}

function chartConfig(kind: "monthly-trend" | "category-trend", data: ChartData): Record<string, unknown> {
  return {
    type: "bar",
    data: { labels: data.labels, datasets: data.datasets.map((dataset, index) => ({ label: dataset.label, data: dataset.values, backgroundColor: ["#FF8A65", "#4DB6AC", "#7986CB", "#FFD54F", "#BA68C8"][index % 5] })) },
    options: {
      responsive: false,
      layout: { padding: { top: 28, right: 28, bottom: 20, left: 20 } },
      legend: { display: true, position: "top", labels: { fontSize: 20, padding: 18, boxWidth: 24 } },
      plugins: { datalabels: { display: true, anchor: "end", align: "end", color: "#333333", font: { size: 17, weight: "bold" } } },
      scales: {
        yAxes: [{ stacked: kind === "category-trend", ticks: { beginAtZero: true, fontSize: 17, padding: 8 } }],
        xAxes: [{ stacked: kind === "category-trend", ticks: { beginAtZero: true, fontSize: 17, padding: 8 } }],
      },
    },
  };
}
