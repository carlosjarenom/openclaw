import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../cron/types.js";
import { removeAgentCronJobs } from "./agent-delete-cron.js";

function job(id: string, agentId?: string, ownerAgentId?: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "test" },
    state: {},
    ...(agentId ? { agentId } : {}),
    ...(ownerAgentId ? { owner: { agentId: ownerAgentId } } : {}),
  };
}

describe("removeAgentCronJobs", () => {
  it("removes legacy and declaratively owned jobs for only the target agent", async () => {
    const remove = vi.fn(async () => ({ ok: true, removed: true }));
    const jobs = [job("legacy", "worker"), job("owned", undefined, "worker"), job("other", "main")];

    const removed = await removeAgentCronJobs(
      { list: async () => jobs, remove } as never,
      "worker",
    );

    expect(removed).toEqual(["legacy", "owned"]);
    expect(remove.mock.calls).toEqual([["legacy"], ["owned"]]);
  });
});
