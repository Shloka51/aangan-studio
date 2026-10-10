import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRICING_MD, QUALIFIED_MD, SERVICES_MD } from "@/core/knowledge/generated";
import { EXCLUDED_AREAS, PCMC_AREAS, PRICING_DEFLECTION, PUNE_AREAS } from "@/core/knowledge";

const read = (f: string) => readFileSync(join(import.meta.dirname, "../knowledge", f), "utf8");

describe("knowledge files are the source of truth", () => {
  it("embedded copies match /knowledge (run `npm run knowledge` if this fails)", () => {
    expect(SERVICES_MD).toBe(read("services.md"));
    expect(QUALIFIED_MD).toBe(read("qualified.md"));
    expect(PRICING_MD).toBe(read("pricing.md"));
  });
  it("parses the deflection and the service area from the files", () => {
    expect(PRICING_DEFLECTION).toMatch(/^Pricing depends on the site/);
    expect(PUNE_AREAS).toContain("Kothrud");
    expect(PCMC_AREAS).toContain("Pimple Saudagar");
    expect(EXCLUDED_AREAS).toEqual(["Talegaon", "Lonavala", "Nashik", "Mumbai"]);
  });
});
