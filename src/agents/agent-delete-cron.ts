import type { CronServiceContract } from "../cron/service-contract.js";

type AgentCronService = Pick<CronServiceContract, "list" | "remove">;

/** Remove scheduler jobs whose persisted execution owner is the deleted agent. */
export async function removeAgentCronJobs(
  cron: AgentCronService,
  agentId: string,
): Promise<string[]> {
  const jobs = await cron.list({ includeDisabled: true });
  const owned = jobs.filter((job) => job.agentId === agentId || job.owner?.agentId === agentId);
  for (const job of owned) {
    await cron.remove(job.id);
  }
  return owned.map((job) => job.id);
}
