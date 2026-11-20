import type { MoatEstimate, MoatStage } from "./types";

export const MOAT_STAGES: readonly MoatStage[] = ["proposed", "created", "verified", "realized"];

/** Expected moat value: P(created and retained over the horizon) × conditional incremental value. */
export function moatPotentialMinor(m: MoatEstimate): number {
  return Math.round(m.pCreatedRetained * m.conditionalValueMinor);
}

export function advanceMoat(stage: MoatStage): MoatStage | null {
  const i = MOAT_STAGES.indexOf(stage);
  return MOAT_STAGES[i + 1] ?? null;
}
