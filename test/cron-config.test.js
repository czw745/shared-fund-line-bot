import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createWorker } from "../src/app";
import { MemoryStore, TestProviders } from "./support";

describe("deployed month-close schedule", () => {
  it.each([2026, 2028])("reaches month close at Taipei midnight across every month in %i", async (year) => {
    const config = readFileSync(new URL("../wrangler.toml.example", import.meta.url), "utf8");
    const cron = config.match(/crons\s*=\s*\["([^"]+)"/)[1];
    const [minute, hour, days, month, weekday] = cron.split(" ");
    expect([month, weekday]).toEqual(["*", "*"]);
    const [first, last = first] = days.split("-").map(Number);
    for (let targetMonth = 0; targetMonth < 12; targetMonth++) {
      const store = new MemoryStore();
      const providers = new TestProviders();
      const worker = createWorker({ store, providers });
      const lastDay = new Date(Date.UTC(year, targetMonth, 0)).getUTCDate();
      for (let day = first; day <= Math.min(last, lastDay); day++) {
        const scheduledTime = Date.UTC(year, targetMonth - 1, day, Number(hour), Number(minute));
        await worker.scheduled?.({ scheduledTime, cron, noRetry() {} }, providers.env);
      }
      const closedMonth = new Date(Date.UTC(year, targetMonth, 0)).toISOString().slice(0, 7);
      expect(store.states.get("GROUP")?.months[closedMonth]?.status, closedMonth).toBe("closed");
      expect(store.states.get("GROUP")?.months[closedMonth]?.closedAt).toBe(Date.UTC(year, targetMonth, 0, 16, 10));
      expect(providers.pushes).toHaveLength(1);
      expect(providers.pushes[0]?.text).toContain(`${closedMonth} 已結算`);
    }
  });
});
