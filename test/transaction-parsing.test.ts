import { describe, expect, it } from "vitest";
import { createWorker } from "../src/app";
import { activeEntries } from "../src/domain";
import type { ParsedTransaction } from "../src/types";
import { MemoryStore, TestProviders, signedLineRequest } from "./support";

const timestamp = Date.UTC(2026, 5, 20, 4);
const expense = (amount: number, smallCategory: string, note?: string): ParsedTransaction => ({
  type: "expense", amount, date: "2026-06-20",
  majorCategory: smallCategory === "停車費" ? "生活" : smallCategory === "汽車" ? "交通" : "飲食",
  smallCategory, ...(note === undefined ? {} : { note }),
});

async function post(text: string, transactions: ParsedTransaction[]) {
  const store = new MemoryStore();
  const providers = new TestProviders();
  providers.parses.push({ intent: "transactions", transactions });
  const worker = createWorker({ store, providers });
  await worker.fetch(await signedLineRequest(text, { timestamp }), providers.env);
  return { store, providers, worker, entries: activeEntries(await store.loadState("GROUP")) };
}

describe("natural-language input regressions", () => {
  it("carries the preceding date across undated lines and blank lines until the next date", async () => {
    const input = "6/10 牛排 晚餐750\n停車50\n\n6/11牛肉麵午餐 400";
    const { entries } = await post(input, [
      { ...expense(750, "晚餐", "牛排"), date: "2026-06-10" },
      { ...expense(50, "停車費", "停車"), date: "2026-06-11" },
      { ...expense(400, "午餐", "牛肉麵"), date: "2026-06-11" },
    ]);
    expect(entries.map(({ date, note }) => ({ date, note }))).toEqual([
      { date: "2026-06-10", note: "牛排" },
      { date: "2026-06-10", note: undefined },
      { date: "2026-06-11", note: "牛肉麵" },
    ]);
    expect(entries.every((entry) => entry.originalText === input)).toBe(true);
  });

  it.each([
    ["加油1000", expense(1000, "汽車"), "加油"],
    ["甜甜圈100", expense(100, "甜點"), "甜甜圈"],
    ["六月18 小館晚餐250", expense(250, "晚餐", "小館晚餐"), "小館"],
    ["早餐200", expense(200, "早餐", "早餐"), undefined],
  ])("retains only useful description for %s", async (input, transaction, note) => {
    const { entries } = await post(input, [transaction]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.note).toBe(note);
  });

  it("normalizes each note separately in a multi-expense message", async () => {
    const { entries } = await post("午餐鐵板麵250\n停車50", [expense(250, "午餐", "午餐鐵板麵"), expense(50, "停車費", "停車")]);
    expect(entries.map((entry) => entry.note)).toEqual(["鐵板麵", undefined]);
  });
});
