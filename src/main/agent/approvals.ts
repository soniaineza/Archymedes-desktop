import type { AgentEvent, ApprovalDecision } from "../../shared/types";

/**
 * Holds shell commands until the user answers. A model's command runs with the user's own
 * permissions, and unlike file edits it cannot be reverted, so in "ask" mode nothing reaches the
 * shell without a decision. Cancelling the run, leaving the workspace or quitting counts as a denial:
 * an unanswered request must never turn into a command that runs later.
 */
export class CommandApprovals {
  private readonly pending = new Map<string, (decision: ApprovalDecision) => void>();
  /** "Always allow" is exact-command and per workspace, and lasts until the app quits. */
  private readonly allowed = new Set<string>();
  private nextId = 1;

  async request(input: {
    workspace: string;
    toolCallId: string;
    command: string;
    emit: (event: AgentEvent) => void;
    signal: AbortSignal;
  }): Promise<boolean> {
    const key = `${input.workspace}\0${input.command.trim()}`;
    if (this.allowed.has(key)) return true;
    if (input.signal.aborted) return false;

    const requestId = `approval-${this.nextId++}`;
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      const onAbort = () => this.resolve(requestId, "deny");
      this.pending.set(requestId, (answer) => {
        input.signal.removeEventListener("abort", onAbort);
        resolve(answer);
      });
      input.signal.addEventListener("abort", onAbort, { once: true });
      input.emit({ type: "approval-request", requestId, toolCallId: input.toolCallId, command: input.command });
      input.emit({ type: "status", status: "awaiting-approval" });
    });
    if (decision === "allow-always") this.allowed.add(key);
    input.emit({ type: "approval-resolved", requestId, decision });
    return decision !== "deny";
  }

  /** Answers a pending request; an unknown or already-answered id is ignored. */
  resolve(requestId: string, decision: ApprovalDecision): void {
    const settle = this.pending.get(requestId);
    if (!settle) return;
    this.pending.delete(requestId);
    settle(decision);
  }

  denyAll(): void {
    for (const id of [...this.pending.keys()]) this.resolve(id, "deny");
  }
}
