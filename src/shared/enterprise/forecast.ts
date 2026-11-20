/** Ordinary least squares on y over x = 0..n-1. */
export function linearFit(ys: number[]): { slope: number; intercept: number; residualSd: number } {
  const n = ys.length;
  const xm = (n - 1) / 2;
  const ym = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  ys.forEach((y, x) => {
    sxy += (x - xm) * (y - ym);
    sxx += (x - xm) ** 2;
  });
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = ym - slope * xm;
  const sse = ys.reduce((s, y, x) => s + (y - (intercept + slope * x)) ** 2, 0);
  return { slope, intercept, residualSd: n > 2 ? Math.sqrt(sse / (n - 2)) : 0 };
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/**
 * Projects the sum of the next `k` periods from the trend in `ys`, with an 80%
 * band and the probability that the sum reaches `target` (independent normal
 * residuals; a planning aid, labelled as such in the UI).
 */
export function projectPeriod(ys: number[], k: number, target: number): { value: number; low: number; high: number; pHit: number; path: number[] } | null {
  if (ys.length < 3 || k < 1) return null;
  const { slope, intercept, residualSd } = linearFit(ys);
  const path = Array.from({ length: k }, (_, i) => intercept + slope * (ys.length + i));
  const value = path.reduce((a, b) => a + b, 0);
  const sd = residualSd * Math.sqrt(k);
  const z80 = 1.2816;
  const pHit = sd === 0 ? (value >= target ? 1 : 0) : 1 - normalCdf((target - value) / sd);
  return { value, low: value - z80 * sd, high: value + z80 * sd, pHit, path };
}
