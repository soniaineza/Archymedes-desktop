import { sha256Hex } from "../../shared/enterprise/sha256";
import type { Decision, EnterpriseState, Objective } from "../../shared/enterprise/api-types";
import type { DecisionSnapshot } from "../../shared/enterprise/types";

/** JSON with object keys sorted, so equal data always hashes equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function sha256(text: string): string {
  return sha256Hex(text);
}

export function hashSnapshot(s: DecisionSnapshot): string {
  return sha256(canonicalJson(s));
}

export function currentPolicy(state: EnterpriseState, tenantId: string) {
  return state.policies.filter((p) => p.tenantId === tenantId).sort((a, b) => b.version - a.version)[0];
}

export function currentProfile(state: EnterpriseState, tenantId: string) {
  return state.profiles.filter((p) => p.tenantId === tenantId).sort((a, b) => b.version - a.version)[0];
}

/** Freezes every input the evaluator will see, at one instant, for one revision. */
export function buildSnapshot(state: EnterpriseState, decision: Decision, objective: Objective, asOf: string): { snapshot: DecisionSnapshot; policyVersion: number } {
  const policy = currentPolicy(state, decision.tenantId);
  const profile = currentProfile(state, decision.tenantId);
  return {
    policyVersion: policy.version,
    snapshot: structuredClone({
      decisionId: decision.id,
      decisionRevision: decision.revision,
      objectiveLabel: objective.name,
      currency: profile.currency,
      horizonDays: decision.horizonDays,
      asOf,
      grossMarginBps: profile.grossMarginBps,
      cohortSize: decision.cohortSize,
      goal: objective.interventionGoal,
      policy: policy.evaluation,
      alternatives: decision.alternatives,
    }),
  };
}
