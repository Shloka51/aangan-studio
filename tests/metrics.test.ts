import { describe, expect, it } from "vitest";
import { computeMetrics, median } from "@/dashboard/metrics";
import { replayFixtures } from "@/dashboard/data";
import { MemoryStore } from "@/store/memory";

describe("dashboard metrics", () => {
  it("median", () => {
    expect(median([])).toBeUndefined();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it("over the September phone transcripts", async () => {
    const store = new MemoryStore();
    await replayFixtures(store);
    const m = computeMetrics(await store.dashboardRows());
    expect(m.received).toBe(21);
    expect(m.outcomes).toEqual([
      { kind: "QUALIFIED", count: 12 },
      { kind: "DECLINED", count: 6 },
      { kind: "ESCALATED", count: 1 },
      { kind: "CALLBACK", count: 2 },
    ]);
    expect(m.booked).toBe(12);
    expect(m.unanswered).toBe(1); // T08 missed call
    expect(m.answeredUnder5MinPct).toBeCloseTo((20 / 21) * 100);
    expect(m.qualificationRatePct).toBeCloseTo((12 / 18) * 100);
    expect(m.afterHours.afterHours.received).toBe(3); // T07 9:44am, T08 10:47pm, T20 9:15am
    expect(m.costInr).toBe(0); // rules brain makes no model calls
  });
});

describe("store config", async () => {
  const { supabaseBaseUrl } = await import("@/store");
  it("tolerates a pasted /rest/v1/ suffix", () => {
    expect(supabaseBaseUrl("https://abc.supabase.co/rest/v1/")).toBe("https://abc.supabase.co");
    expect(supabaseBaseUrl(" https://abc.supabase.co ")).toBe("https://abc.supabase.co");
  });
});
