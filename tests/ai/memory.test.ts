import { describe, expect, it } from "vitest";
import { parseReflectionRecord } from "../../src/ai/memory";

describe("parseReflectionRecord", () => {
  it("parses structured reflection JSON", () => {
    const parsed = parseReflectionRecord(
      JSON.stringify({
        summary: "Missed a closer role change and chased ratios too hard.",
        strengths: ["Protected SB lead correctly."],
        misses: ["Missed saves leverage on Friday."],
        tags: ["missed_role_change", "too_aggressive_ratios"],
        tuningIdeas: ["Lower the bar for new closers in swing weeks."],
        confidence: 0.84,
      }),
    );

    expect(parsed?.summary).toContain("closer role change");
    expect(parsed?.tags).toContain("missed_role_change");
    expect(parsed?.tuningIdeas[0]).toContain("new closers");
  });

  it("returns null for legacy plain-text reflections", () => {
    expect(parseReflectionRecord("Streamed too aggressively into WHIP damage.")).toBeNull();
  });
});
