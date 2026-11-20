import { describe, expect, it } from "vitest";
import { linearFit, normalCdf, projectPeriod } from "./forecast";

describe("forecast", () => {
  it("fits an exact line", () => {
    const f = linearFit([1, 3, 5, 7]);
    expect(f.slope).toBeCloseTo(2, 12);
    expect(f.intercept).toBeCloseTo(1, 12);
    expect(f.residualSd).toBeCloseTo(0, 12);
  });
  it("normal CDF matches known points", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 4);
  });
  it("projects the next k periods' sum with a band and P(hit)", () => {
    const p = projectPeriod([10, 10, 10, 10], 3, 30)!;
    expect(p.value).toBeCloseTo(30, 9);
    expect(p.pHit).toBeGreaterThanOrEqual(0.5);
    expect(p.low).toBeLessThanOrEqual(p.value);
    expect(p.high).toBeGreaterThanOrEqual(p.value);
    expect(projectPeriod([10, 12, 9, 11, 10, 13], 4, 1000)!.pHit).toBeLessThan(0.01);
  });
  it("needs at least three points", () => {
    expect(projectPeriod([1, 2], 3, 10)).toBeNull();
  });
});
