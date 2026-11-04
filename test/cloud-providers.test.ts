import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudProviders } from "../src/cloud-providers";
import type { CloudEnv } from "../src/types";

describe("Gemini cloud provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the supported free-tier Gemini model by default", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ intent: "zero_contribution" }) }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const providers = new CloudProviders({ GEMINI_API_KEY: "test-key" } as CloudEnv);
    await providers.parse("本月不存", { eventDate: "2026-08-04", categories: {} });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/models/gemini-3.5-flash-lite:generateContent");
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
      generationConfig: { responseJsonSchema?: { required?: string[]; properties?: Record<string, unknown> } };
    };
    expect(request.contents[0]?.parts[0]?.text).toContain("這個月存入");
    expect(request.generationConfig.responseJsonSchema?.required).toContain("intent");
    expect(request.generationConfig.responseJsonSchema?.properties).toHaveProperty("transactions");
  });

  it("falls back to a text message for an incomplete Flex payload", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const providers = new CloudProviders({ LINE_CHANNEL_ACCESS_TOKEN: "test-token" } as CloudEnv);

    await providers.reply("reply-token", { text: "存入成功", flex: { type: "bubble", altText: "invalid" } });

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { messages: Array<Record<string, unknown>> };
    expect(request.messages[0]).toEqual({ type: "text", text: "存入成功" });
  });

  it("recovers a clear daily-goods category when Gemini leaves a known product ambiguous", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        intent: "transactions",
        transactions: [{ type: "expense", amount: 400, date: "2026-08-05" }],
        ambiguous: true,
      }) }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const providers = new CloudProviders({ GEMINI_API_KEY: "test-key" } as CloudEnv);

    const result = await providers.parse("風倍清 3瓶 400", { eventDate: "2026-08-05", categories: {} });

    expect(result).toEqual({
      intent: "transactions",
      transactions: [{ type: "expense", amount: 400, date: "2026-08-05", majorCategory: "購物", smallCategory: "日用品", note: "風倍清 3瓶" }],
      ambiguous: false,
    });
  });
});
