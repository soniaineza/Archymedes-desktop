import type { DecisionState } from "./types";

/**
 * Legal decision transitions: the spec §7 state diagram, plus three edges it
 * implies in prose — a material edit returns an evaluated/awaiting/approved or
 * rejected decision to Draft as a new revision, and work may be cancelled with a
 * reason (forecast preserved).
 */
const TRANSITIONS: Record<DecisionState, readonly DecisionState[]> = {
  Draft: ["Evaluated"],
  Evaluated: ["NeedsEvidence", "AwaitingApproval", "Draft"],
  NeedsEvidence: ["Draft"],
  AwaitingApproval: ["Approved", "Rejected", "NeedsEvidence", "Draft"],
  Approved: ["Executing", "Draft", "Cancelled"],
  Rejected: ["Draft"],
  Executing: ["DeliveryReview", "Cancelled"],
  DeliveryReview: ["Executing", "Measuring", "Cancelled"],
  Measuring: ["Debriefed"],
  Debriefed: [],
  Cancelled: [],
};

export function canTransition(from: DecisionState, to: DecisionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function nextStates(from: DecisionState): DecisionState[] {
  return [...TRANSITIONS[from]];
}

/** The happy path, for the lifecycle rail in the UI. */
export const LIFECYCLE: readonly DecisionState[] = [
  "Draft",
  "Evaluated",
  "AwaitingApproval",
  "Approved",
  "Executing",
  "DeliveryReview",
  "Measuring",
  "Debriefed",
];
