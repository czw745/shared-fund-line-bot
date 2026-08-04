import { describe, expect, it } from "vitest";
import { createWorker } from "../src/app";
import { MemoryStore, TestProviders, signedLineRequest } from "./support";

describe("LINE Worker handler", () => {
  it("answers help for an authenticated spouse exactly once", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    const worker = createWorker({ store, providers });
    const request = await signedLineRequest("說明", { eventId: "evt-1" });

    expect((await worker.fetch(request, providers.env)).status).toBe(200);
    expect(providers.replies.at(-1)?.text).toContain("餘額");

    const replay = await signedLineRequest("說明", { eventId: "evt-1" });
    expect((await worker.fetch(replay, providers.env)).status).toBe(200);
    expect(providers.replies).toHaveLength(1);
  });

  it("ignores invalid signatures and unauthorized sources", async () => {
    const store = new MemoryStore();
    const providers = new TestProviders();
    const worker = createWorker({ store, providers });
    const invalid = await signedLineRequest("說明", { signature: "invalid" });
    const outsider = await signedLineRequest("說明", { userId: "OUTSIDER" });

    expect((await worker.fetch(invalid, providers.env)).status).toBe(401);
    expect((await worker.fetch(outsider, providers.env)).status).toBe(200);
    expect(providers.replies).toHaveLength(0);
    expect(store.events).toHaveLength(0);
  });
});
