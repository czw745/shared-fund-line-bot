import { describe, expect, it } from "vitest";
import { validFlexContainer } from "../src/flex-validation";

describe("LINE Flex validation", () => {
  it("accepts a valid bubble", () => {
    expect(validFlexContainer({ type: "bubble", body: { type: "box", layout: "vertical", contents: [] } })).toBe(true);
  });

  it("rejects an empty or oversized carousel", () => {
    expect(validFlexContainer({ type: "carousel", contents: [] })).toBe(false);
    expect(validFlexContainer({ type: "carousel", contents: Array.from({ length: 13 }, () => ({ type: "bubble", body: { type: "box", layout: "vertical", contents: [] } })) })).toBe(false);
  });

  it("rejects bubbles larger than LINE's 30 KB limit", () => {
    expect(validFlexContainer({ type: "bubble", body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "x".repeat(31_000) }] } })).toBe(false);
  });
});

