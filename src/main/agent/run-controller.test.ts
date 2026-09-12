import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_SETTINGS } from "../../shared/types";
import { AgentRunController } from "./run-controller";
import type { AgentRun } from "./run-controller";

class ControllableRun implements AgentRun {
  cancelled = false;
  private finish!: (error?: Error) => void;
  private readonly finished = new Promise<void>((resolve, reject) => {
    this.finish = (error) => (error ? reject(error) : resolve());
  });

  run(): Promise<void> {
    return this.finished;
  }

  cancel(): void {
    this.cancelled = true;
    this.finish();
  }

  fail(error: Error): void {
    this.finish(error);
  }
}

function setup() {
  const runs: ControllableRun[] = [];
  const controller = new AgentRunController(() => {
    const run = new ControllableRun();
    runs.push(run);
    return run;
  });
  const start = () => controller.start(DEFAULT_PROVIDER_SETTINGS, "/workspace", [], () => {});
  return { controller, runs, start };
}

describe("AgentRunController", () => {
  it("cancels the run in flight when a new one starts", async () => {
    const { runs, start } = setup();
    const first = start();
    const second = start();
    expect(runs[0].cancelled).toBe(true);
    expect(runs[1].cancelled).toBe(false);
    await first;
    runs[1].cancel();
    await second;
  });

  it("forgets a run once it finishes, so cancel afterwards is a no-op", async () => {
    const { controller, runs, start } = setup();
    const running = start();
    expect(controller.running).toBe(true);
    runs[0].cancel();
    await running;
    expect(controller.running).toBe(false);
    expect(() => controller.cancel()).not.toThrow();
  });

  it("propagates a failed run's error and still clears it", async () => {
    const { controller, runs, start } = setup();
    const running = start();
    runs[0].fail(new Error("provider down"));
    await expect(running).rejects.toThrow("provider down");
    expect(controller.running).toBe(false);
  });
});
