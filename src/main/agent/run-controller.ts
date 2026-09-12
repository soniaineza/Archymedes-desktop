import type { AgentEvent, ChatMessage, ProviderSettings } from "../../shared/types";

export interface AgentRun {
  run(history: ChatMessage[]): Promise<void>;
  cancel(): void;
}

export type RunFactory = (settings: ProviderSettings, workspace: string, emit: (event: AgentEvent) => void) => AgentRun;

/** Owns the one agent run the app has at a time: starting a run cancels the one in flight. */
export class AgentRunController {
  private current: AgentRun | null = null;

  constructor(private readonly createRun: RunFactory) {}

  get running(): boolean {
    return this.current !== null;
  }

  async start(
    settings: ProviderSettings,
    workspace: string,
    history: ChatMessage[],
    emit: (event: AgentEvent) => void,
  ): Promise<void> {
    this.current?.cancel();
    const run = this.createRun(settings, workspace, emit);
    this.current = run;
    try {
      await run.run(history);
    } finally {
      if (this.current === run) this.current = null;
    }
  }

  cancel(): void {
    this.current?.cancel();
  }
}
